/*
 * AniEvo Brave Bridge — sisi extension (service worker).
 *
 * Cara kerja: extension ini TIDAK membuka port sendiri. Dia "menempel keluar"
 * dengan long-poll ke server lokal (tools/brave-bridge.mjs). Jadi Brave yang
 * sudah jalan cukup di-load extension ini SEKALI, tidak perlu di-close/relaunch.
 *
 * Alur:
 *   poll /poll  -> dapat perintah -> jalankan via chrome.* API -> POST /result
 *
 * Catatan jujur soal batasan (mode extension, bukan CDP):
 *   - screenshot = area viewport yang kelihatan (captureVisibleTab), bukan full page
 *   - key event bersifat sintetis (tidak memicu shortcut native browser)
 *   - console/network capture tidak tersedia (perlu CDP, pakai tools/brave-cdp.mjs)
 */

// Coba beberapa host: localhost dulu, lalu 127.0.0.1, lalu IP LAN.
const SERVERS = [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
];
let SERVER = SERVERS[0];
console.log("[bridge] service worker loaded, id:", chrome.runtime.id);
const POLL_MS = 8000; // poll pendek biar service worker nggak idle
const RETRY_MS = 1500;
const BLOCKED_SCHEME = /^(chrome|brave|edge|about|devtools|chrome-extension|brave-extension|view-source|chrome-untrusted):/i;

let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => v === true || v === "true" || v === "1" || v === 1;

const bad = (msg) => {
    const e = new Error(msg);
    e.__bridge = true;
    return e;
};

function setBadge(text, color) {
    try {
        chrome.action.setBadgeText({ text });
        if (color) chrome.action.setBadgeBackgroundColor({ color });
    } catch {
        /* badge opsional */
    }
}

// ------------------------------------------------------------------ helpers
async function activeTabId() {
    const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused[0]) return focused[0].id;
    const any = await chrome.tabs.query({ active: true });
    if (any[0]) return any[0].id;
    throw bad("Tidak ada tab aktif.");
}

async function tabIdOf(params) {
    const t = params.flags ? params.flags.tabId : undefined;
    if (t !== undefined && t !== true) return Number(t);
    if (params.args && params.args.tabId !== undefined) return Number(params.args.tabId);
    return activeTabId();
}

async function ensureInjectable(tabId) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw bad(`Tab tidak ketemu: ${tabId}`);
    if (!t.url || BLOCKED_SCHEME.test(t.url)) {
        throw bad(`Tidak bisa inject ke halaman ini (${t.url || "?"}). Buka halaman web biasa dulu.`);
    }
    return t;
}

// Jalankan fungsi di dalam tab. Default world MAIN (bisa lihat JS halaman),
// fallback ke ISOLATED kalau CSP halaman memblokir.
async function run(tabId, func, args = [], world = "MAIN") {
    await ensureInjectable(tabId);
    try {
        const out = await chrome.scripting.executeScript({ target: { tabId }, world, func, args });
        return out[0] ? out[0].result : undefined;
    } catch (e) {
        if (world === "MAIN") {
            const out = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func, args });
            return out[0] ? out[0].result : undefined;
        }
        throw e;
    }
}

function waitComplete(tabId, timeout = 20000) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            clearTimeout(grace);
            resolve(v);
        };
        const listener = (id, info) => {
            if (id === tabId && info.status === "complete") done(true);
        };
        chrome.tabs.onUpdated.addListener(listener);
        const timer = setTimeout(() => done(false), timeout);
        // Cek "sudah complete" setelah jeda kecil supaya tidak salah baca halaman lama.
        const grace = setTimeout(() => {
            chrome.tabs.get(tabId).then((t) => {
                if (t && t.status === "complete") done(true);
            }).catch(() => { });
        }, 500);
    });
}

// ---------------------------------------------------------------- tab group
// Masukkan tab ke tab group dari flag --group "Nama" (opsional --color blue).
// Group dengan judul sama di window itu akan di-reuse, bukan dibuat baru.
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
async function applyGroup(tabId, flags) {
    const name = flags.group;
    if (!name || name === true) return undefined;
    const title = String(name);
    const tab = await chrome.tabs.get(tabId);
    let groupId;
    try {
        const found = await chrome.tabGroups.query({ windowId: tab.windowId, title });
        if (found && found.length) groupId = found[0].id;
    } catch {
        /* tabGroups.query butuh permission "tabGroups"; kalau gagal, buat group baru saja */
    }
    groupId = await chrome.tabs.group(groupId ? { tabIds: [tabId], groupId } : { tabIds: [tabId] });
    const patch = { title };
    const color = typeof flags.color === "string" ? flags.color.toLowerCase() : null;
    if (color && GROUP_COLORS.includes(color)) patch.color = color;
    try {
        await chrome.tabGroups.update(groupId, patch);
    } catch {
        /* update judul/warna butuh permission "tabGroups" */
    }
    return groupId;
}

// ------------------------------------------------------------------ handlers
async function handle(cmd, params = {}) {
    const args = params.args || [];
    const flags = params.flags || {};

    switch (cmd) {
        case "ping":
        case "status": {
            const tabs = await chrome.tabs.query({});
            return {
                ok: true,
                ext: chrome.runtime.getManifest().version,
                tabs: tabs.length,
                server: SERVER,
            };
        }

        case "tabs": {
            const tabs = await chrome.tabs.query({});
            const groups = await chrome.tabGroups.query({}).catch(() => []);
            const gmap = new Map(groups.map((g) => [g.id, g.title]));
            let out = tabs.map((t) => ({
                id: t.id,
                windowId: t.windowId,
                active: !!t.active,
                pinned: !!t.pinned,
                groupId: t.groupId === -1 || t.groupId === undefined ? null : t.groupId,
                group: t.groupId === -1 || t.groupId === undefined ? null : gmap.get(t.groupId) || null,
                title: t.title,
                url: t.url,
            }));
            const want = typeof flags.group === "string" ? flags.group : null;
            if (want) out = out.filter((t) => t.group === want);
            return out;
        }

        case "closeGroup":
        case "close-group": {
            const name = args[0] || flags.group;
            if (!name || name === true) throw bad('Butuh nama group: close-group "Nama"');
            const title = String(name);
            const groups = await chrome.tabGroups.query({ title }).catch(() => []);
            if (!groups.length) return { closed: [], count: 0, group: title, note: `group "${title}" tidak ada` };
            const gids = new Set(groups.map((g) => g.id));
            const tabs = await chrome.tabs.query({});
            const targets = tabs.filter((t) => gids.has(t.groupId)).map((t) => t.id);
            if (targets.length) await chrome.tabs.remove(targets);
            return { closed: targets, count: targets.length, group: title };
        }

        case "active": {
            const t = await chrome.tabs.get(await activeTabId());
            return { id: t.id, windowId: t.windowId, active: true, title: t.title, url: t.url, status: t.status };
        }

        case "goto":
        case "open": {
            const url = args[0] || flags.url;
            if (!url) throw bad("Butuh URL.");
            const asNew = cmd === "open" || truthy(flags.new);
            let id;
            let groupId;
            if (asNew) {
                const t = await chrome.tabs.create({ url, active: !truthy(flags.background) });
                id = t.id;
                groupId = await applyGroup(id, flags);
            } else {
                id = await tabIdOf(params);
                await chrome.tabs.update(id, { url });
            }
            if (!truthy(flags.nowait) && flags.wait !== "false") await waitComplete(id, Number(flags.timeout || 25000));
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url, title: t.title, status: t.status, groupId };
        }

        case "new": {
            const url = args[0] || flags.url || "about:blank";
            const t = await chrome.tabs.create({ url, active: !truthy(flags.background) });
            const groupId = await applyGroup(t.id, flags);
            if (url !== "about:blank" && !truthy(flags.nowait)) await waitComplete(t.id, Number(flags.timeout || 25000));
            const tab = await chrome.tabs.get(t.id);
            return { tabId: tab.id, url: tab.url, title: tab.title, groupId };
        }

        case "close": {
            const id = flags.tabId !== undefined ? Number(flags.tabId) : args[0] !== undefined ? Number(args[0]) : await activeTabId();
            await chrome.tabs.remove(id);
            return { closed: id };
        }

        case "activate": {
            const id = flags.tabId !== undefined ? Number(flags.tabId) : Number(args[0]);
            const t = await chrome.tabs.update(id, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
            return { tabId: t.id, url: t.url, title: t.title };
        }

        case "reload": {
            const id = await tabIdOf(params);
            await chrome.tabs.reload(id, { bypassCache: truthy(flags.hard) });
            if (!truthy(flags.nowait)) await waitComplete(id, Number(flags.timeout || 25000));
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url, status: t.status };
        }

        case "back":
        case "forward": {
            const id = await tabIdOf(params);
            if (cmd === "back") await chrome.tabs.goBack(id);
            else await chrome.tabs.goForward(id);
            if (!truthy(flags.nowait)) await waitComplete(id, 15000);
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url };
        }

        case "url":
        case "title": {
            const t = await chrome.tabs.get(await tabIdOf(params));
            return { url: t.url, title: t.title };
        }

        case "eval": {
            const code = args.join(" ");
            if (!code) throw bad("Butuh ekspresi.");
            const id = await tabIdOf(params);
            const r = await run(
                id,
                (src) => {
                    try {
                        // eslint-disable-next-line no-eval
                        return { ok: true, value: eval(src) };
                    } catch (e) {
                        return { ok: false, error: String((e && e.message) || e) };
                    }
                },
                [code],
                truthy(flags.isolated) ? "ISOLATED" : "MAIN"
            );
            if (r && r.ok === false) throw bad(r.error);
            return r ? r.value : undefined;
        }

        case "text": {
            const sel = args[0];
            const id = await tabIdOf(params);
            return await run(id, (s) => {
                const el = s ? document.querySelector(s) : document.body;
                if (!el) return null;
                return (el.innerText || el.textContent || "").trim();
            }, [sel || ""]);
        }

        case "html": {
            const sel = args[0];
            const id = await tabIdOf(params);
            return await run(id, (s) => {
                const el = s ? document.querySelector(s) : document.documentElement;
                return el ? el.outerHTML : null;
            }, [sel || ""]);
        }

        case "count": {
            const id = await tabIdOf(params);
            return await run(id, (s) => document.querySelectorAll(s).length, [args[0]]);
        }

        case "attr": {
            const [sel, name] = args;
            const id = await tabIdOf(params);
            return await run(id, (s, n) => {
                const el = document.querySelector(s);
                return el ? el.getAttribute(n) : null;
            }, [sel, name]);
        }

        case "click": {
            const sel = args[0];
            const id = await tabIdOf(params);
            const r = await run(
                id,
                (s, txt, idx) => {
                    let el = null;
                    if (s) el = document.querySelectorAll(s)[idx];
                    else if (txt) {
                        const all = Array.from(
                            document.querySelectorAll("button,a,[role=button],input[type=submit],label,li,span,div")
                        );
                        el =
                            all.find((e) => ((e.innerText || e.value || "").trim() === txt)) ||
                            all.find((e) => ((e.innerText || "").trim().includes(txt)));
                    }
                    if (!el) return { ok: false, error: "Elemen tidak ketemu." };
                    el.scrollIntoView({ block: "center" });
                    if (el.focus) el.focus();
                    el.click();
                    return { ok: true, tag: el.tagName, text: (el.innerText || el.value || "").slice(0, 120) };
                },
                [sel || "", flags.text ? String(flags.text) : null, Number(flags.index || 0)]
            );
            if (!r || !r.ok) throw bad(r ? r.error : "Gagal klik.");
            return r;
        }

        case "fill":
        case "type": {
            const [sel, value = ""] = args;
            if (!sel) throw bad("Butuh selector.");
            const id = await tabIdOf(params);
            const append = cmd === "type" && truthy(flags.append);
            const r = await run(
                id,
                (s, v, ap, idx) => {
                    const el = document.querySelectorAll(s)[idx];
                    if (!el) return { ok: false, error: "Elemen tidak ketemu: " + s };
                    el.scrollIntoView({ block: "center" });
                    el.focus();
                    if (el.isContentEditable) {
                        el.textContent = ap ? (el.textContent || "") + v : v;
                    } else {
                        const next = ap ? (el.value || "") + v : v;
                        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
                        if (setter) setter.call(el, next);
                        else el.value = next;
                    }
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                    return { ok: true, value: el.isContentEditable ? el.textContent : el.value };
                },
                [sel, value, append, Number(flags.index || 0)]
            );
            if (!r || !r.ok) throw bad(r ? r.error : "Gagal isi.");
            return r;
        }

        case "select": {
            const [sel, value] = args;
            const id = await tabIdOf(params);
            const r = await run(id, (s, v) => {
                const el = document.querySelector(s);
                if (!el) return { ok: false, error: "Elemen tidak ketemu." };
                const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
                if (desc && desc.set) desc.set.call(el, v);
                else el.value = v;
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true, value: el.value };
            }, [sel, value]);
            if (!r || !r.ok) throw bad(r ? r.error : "Gagal select.");
            return r;
        }

        case "check":
        case "uncheck": {
            const want = cmd === "check";
            const id = await tabIdOf(params);
            const r = await run(id, (s, w) => {
                const el = document.querySelector(s);
                if (!el) return { ok: false, error: "Elemen tidak ketemu." };
                if (el.checked !== w) el.click();
                return { ok: true, checked: el.checked };
            }, [args[0], want]);
            if (!r || !r.ok) throw bad(r ? r.error : "Gagal.");
            return r;
        }

        case "key": {
            const combo = args[0];
            if (!combo) throw bad("Butuh kombinasi, mis. Control+a");
            const id = await tabIdOf(params);
            const r = await run(id, (c, sel) => {
                const target = sel ? document.querySelector(sel) : document.activeElement || document.body;
                if (!target) return { ok: false, error: "Target tidak ketemu." };
                const parts = String(c).split("+").map((x) => x.trim());
                const key = parts.pop();
                const o = { key, bubbles: true, cancelable: true };
                if (parts.some((p) => /ctrl|control/i.test(p))) o.ctrlKey = true;
                if (parts.some((p) => /shift/i.test(p))) o.shiftKey = true;
                if (parts.some((p) => /alt/i.test(p))) o.altKey = true;
                if (parts.some((p) => /meta|cmd|win/i.test(p))) o.metaKey = true;
                target.dispatchEvent(new KeyboardEvent("keydown", o));
                target.dispatchEvent(new KeyboardEvent("keyup", o));
                return { ok: true, key, target: target.tagName };
            }, [combo, args[1] || ""]);
            if (!r || !r.ok) throw bad(r ? r.error : "Gagal key.");
            return r;
        }

        case "wait": {
            const ms = Number(args[0] || flags.ms || 1000);
            await sleep(ms);
            return { waited: ms };
        }

        case "waitFor": {
            const sel = args[0];
            if (!sel) throw bad("Butuh selector.");
            const id = await tabIdOf(params);
            const timeout = Number(flags.timeout || 15000);
            const t0 = Date.now();
            while (Date.now() - t0 < timeout) {
                const found = await run(id, (s) => {
                    const el = document.querySelector(s);
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }, [sel]);
                if (found) return { found: true, waitedMs: Date.now() - t0 };
                await sleep(250);
            }
            throw bad(`Timeout ${timeout}ms nunggu: ${sel}`);
        }

        case "scroll": {
            const target = args[0];
            const id = await tabIdOf(params);
            return await run(id, (t) => {
                if (!t || t === "bottom") window.scrollTo(0, document.body.scrollHeight);
                else if (t === "top") window.scrollTo(0, 0);
                else {
                    const el = document.querySelector(t);
                    if (!el) return { ok: false, error: "Elemen tidak ketemu." };
                    el.scrollIntoView({ block: "center" });
                }
                return { ok: true, y: window.scrollY };
            }, [target || "bottom"]);
        }

        case "shot": {
            const id = await tabIdOf(params);
            const t = await chrome.tabs.get(id);
            const format = truthy(flags.jpeg) || truthy(flags.jpg) ? "jpeg" : "png";
            const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, {
                format,
                quality: format === "jpeg" ? Number(flags.quality || 80) : undefined,
            });
            return {
                dataUrl,
                tabId: t.id,
                url: t.url,
                title: t.title,
                note: "captureVisibleTab = area yang kelihatan saja (bukan full page).",
            };
        }

        case "window": {
            const win = await chrome.windows.getLastFocused();
            if (flags.state || flags.width || flags.height || flags.left || flags.top) {
                const upd = {};
                if (flags.state) upd.state = String(flags.state);
                if (flags.width) upd.width = Number(flags.width);
                if (flags.height) upd.height = Number(flags.height);
                if (flags.left) upd.left = Number(flags.left);
                if (flags.top) upd.top = Number(flags.top);
                const w = await chrome.windows.update(win.id, upd);
                return { id: w.id, state: w.state, width: w.width, height: w.height, left: w.left, top: w.top };
            }
            return {
                id: win.id,
                state: win.state,
                width: win.width,
                height: win.height,
                left: win.left,
                top: win.top,
                focused: win.focused,
            };
        }

        case "console":
        case "net":
            throw bad(`${cmd}: tidak tersedia di mode extension (butuh CDP). Pakai tools/brave-cdp.mjs untuk console/network.`);

        default:
            throw bad(`Command tidak dikenal: ${cmd}`);
    }
}

// ------------------------------------------------------------------ poll loop
// Coba semua server di SERVERS; pakai yang pertama berhasil.
async function fetchAny(path, opts = {}) {
    let lastErr;
    for (const base of SERVERS) {
        try {
            const res = await fetch(`${base}${path}`, opts);
            SERVER = base; // yang berhasil dipakai seterusnya
            return res;
        } catch (e) {
            console.error(`[bridge] FAIL ${base}${path}:`, e && e.message ? e.message : e);
            lastErr = e;
        }
    }
    throw lastErr || new Error("semua server gagal");
}

async function post(path, body) {
    const res = await fetchAny(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function start() {
    if (running) return;
    running = true;
    console.log("[bridge] start() running, servers:", SERVERS);
    // eslint-disable-next-line no-constant-condition
    for (; ;) {
        try {
            const res = await fetchAny(`/poll?sid=${encodeURIComponent(chrome.runtime.id)}`);
            const job = await res.json();
            setBadge("ON", "#2563eb");
            if (job && job.id && job.cmd) {
                let payload;
                try {
                    const result = await handle(job.cmd, job.params || {});
                    payload = { id: job.id, ok: true, result };
                } catch (e) {
                    payload = { id: job.id, ok: false, error: String((e && e.message) || e) };
                }
                await post("/result", payload).catch(() => { });
            }
        } catch {
            setBadge("OFF", "#dc2626");
            await sleep(RETRY_MS);
        }
    }
}

chrome.runtime.onInstalled.addListener(() => start());
chrome.runtime.onStartup.addListener(() => start());
chrome.alarms.onAlarm.addListener(() => start());
// Panggil start() DULU sebelum set alarm, biar poll langsung jalan walau alarm gagal didaftarkan.
start();
// periodInMinutes minimum di Brave/Chromium bisa 1 menit (ada yang tolak 0.5). Wrap try/catch.
try {
    chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
} catch (e) {
    // alarm optional; start() loop tetap jalan via setTimeout di dalam start().
}
