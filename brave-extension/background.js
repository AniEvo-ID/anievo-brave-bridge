/*
 * AniEvo Brave Bridge v2 — service worker extension.
 *
 * Transport: WebSocket ke ws://127.0.0.1:8787/ws (cuma localhost). Server memverifikasi
 * Origin chrome-extension://<id> ini, jadi website biasa tidak bisa menyamar jadi extension.
 * WebSocket aktif menjaga service worker tetap hidup (Chrome 116+); alarm 1 menit = cadangan.
 *
 * Mode CDP opsional (chrome.debugger) menempel ke tab yang SUDAH terbuka, tanpa relaunch:
 * console/network capture, input trusted, eval tembus CSP, upload file, screenshot full page.
 * Brave menampilkan bar "sedang di-debug" selama attach — makanya opt-in dan auto-detach.
 */

const WS_URL = "ws://127.0.0.1:8787/ws";
const VERSION = chrome.runtime.getManifest().version;
const BLOCKED_SCHEME = /^(chrome|brave|edge|about|devtools|chrome-extension|brave-extension|view-source|chrome-untrusted):/i;
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
// Command yang mengubah halaman/tab -> kena guard tab group.
const MUTATING = new Set([
    "goto", "reload", "back", "forward", "close", "click", "dblclick", "rightclick", "drag",
    "hover", "fill", "type", "select", "check", "uncheck", "key", "scroll", "eval", "upload",
    "focus", "dialog", "cookies", "storage", "emulate",
]);

const DEVICES = {
    iphone: {
        width: 390,
        height: 844,
        dpr: 3,
        mobile: true,
        ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    },
    pixel: {
        width: 412,
        height: 915,
        dpr: 2.625,
        mobile: true,
        ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    },
    ipad: {
        width: 820,
        height: 1180,
        dpr: 2,
        mobile: true,
        ua: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    },
    desktop: { width: 1440, height: 900, dpr: 1, mobile: false, ua: "" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => v === true || v === "true" || v === "1" || v === 1;
const bad = (msg) => Object.assign(new Error(msg), { __bridge: true });

function setBadge(text, color) {
    try {
        chrome.action.setBadgeText({ text });
        if (color) chrome.action.setBadgeBackgroundColor({ color });
    } catch {
        /* opsional */
    }
}

// ------------------------------------------------------------------ tab helpers
async function activeTabId() {
    const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focused[0]) return focused[0].id;
    const any = await chrome.tabs.query({ active: true });
    if (any[0]) return any[0].id;
    throw bad("Tidak ada tab aktif.");
}

async function tabIdOf(flags, args) {
    if (flags.tabId !== undefined && flags.tabId !== true) return Number(flags.tabId);
    if (args && args.tabId !== undefined) return Number(args.tabId);
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

// Fallback kalau tab strip tidak mendukung tabGroups (mis. Chromium headless di CI).
const virtualGroups = new Map(); // tabId -> groupTitle
chrome.tabs.onRemoved.addListener((tabId) => virtualGroups.delete(tabId));

async function groupTitleOf(tab) {
    if (tab.groupId !== undefined && tab.groupId !== -1) {
        const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
        if (g) return g.title;
    }
    return virtualGroups.get(tab.id) || null;
}

const isAgentGroupTitle = (title, base) => title === base || (typeof title === "string" && title.startsWith(base + "-"));

// Tolak aksi yang mengubah tab milik user (di luar group bridge) atau tab sesi agent lain, kecuali --force.
async function guard(cmd, tabId, flags) {
    if (!truthy(flags.__guard) || truthy(flags.force) || !MUTATING.has(cmd)) return;
    const base = String(flags.__guardGroup || "Antigravity");
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw bad(`Tab tidak ketemu: ${tabId}`);
    const title = await groupTitleOf(t);
    if (!isAgentGroupTitle(title, base)) {
        throw bad(
            `GUARD: tab ${tabId} ("${(t.title || "").slice(0, 60)}") bukan di group "${base}" (atau "${base}-*"), jadi dianggap tab milik user. ` +
            `Pakai tab sendiri (new <url> / goto <url> --new, lalu --tabId N), atau tambah --force kalau user memang minta.`
        );
    }
    if (flags.__sessionGroup && title !== String(flags.__sessionGroup)) {
        throw bad(
            `GUARD: tab ${tabId} ada di group sesi lain ("${title}"), bukan sesi aktif ("${flags.__sessionGroup}"). ` +
            `Pakai --tabId milik sesi ini, atau tambah --force.`
        );
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
        const grace = setTimeout(() => {
            chrome.tabs.get(tabId).then((t) => t && t.status === "complete" && done(true)).catch(() => { });
        }, 500);
    });
}

async function applyGroup(tabId, flags) {
    const name = flags.group;
    if (!name || name === true) return undefined;
    const title = String(name);
    const tab = await chrome.tabs.get(tabId);
    let groupId;
    try {
        const found = await chrome.tabGroups.query({ windowId: tab.windowId, title }).catch(() => []);
        if (found.length) groupId = found[0].id;
        groupId = await chrome.tabs.group(groupId ? { tabIds: [tabId], groupId } : { tabIds: [tabId] });
        const patch = { title };
        const color = typeof flags.color === "string" ? flags.color.toLowerCase() : null;
        if (color && GROUP_COLORS.includes(color)) patch.color = color;
        await chrome.tabGroups.update(groupId, patch).catch(() => { });
        return groupId;
    } catch {
        // Headless Chromium tanpa tab strip: simpan asosiasi group di memori.
        virtualGroups.set(tabId, title);
        return -2;
    }
}

// ------------------------------------------------------------------ DOM (isolated world)
async function frameTarget(tabId, flags, sel) {
    const f = flags.frame;
    if (f === undefined || f === true) return { tabId };
    if (String(f) !== "all") return { tabId, frameIds: [Number(f)] };
    // --frame all: cari frame pertama yang punya elemen tsb.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["page.js"] });
    const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (s) => globalThis.__bb.run("exists", { sel: s }),
        args: [sel || ""],
    });
    const hit = res.find((r) => r.result === true);
    if (!hit) throw bad(`Elemen tidak ketemu di frame mana pun: ${sel}`);
    return { tabId, frameIds: [hit.frameId] };
}

async function dom(tabId, flags, op, o = {}) {
    await ensureInjectable(tabId);
    const target = await frameTarget(tabId, flags, o.sel);
    await chrome.scripting.executeScript({ target, files: ["page.js"] });
    const out = await chrome.scripting.executeScript({
        target,
        func: (op2, o2) => globalThis.__bb.run(op2, o2),
        args: [op, o],
    });
    const r = out[0] ? out[0].result : undefined;
    if (r && typeof r === "object" && r.__err) throw bad(r.__err);
    return r;
}

// ------------------------------------------------------------------ CDP (chrome.debugger)
const dbg = new Map(); // tabId -> { persistent, console: [], net: Map }
const MAX_CONSOLE = 1000;
const MAX_NET = 500;

async function attach(tabId) {
    if (dbg.has(tabId)) return dbg.get(tabId);
    await ensureInjectable(tabId);
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
        throw bad(`Gagal attach debugger ke tab ${tabId}: ${e.message}. (DevTools sedang terbuka di tab itu?)`);
    }
    const s = { persistent: false, emulating: false, dialogMode: null, dialogPrompt: undefined, dialogs: [], console: [], net: new Map() };
    dbg.set(tabId, s);
    return s;
}

async function detach(tabId) {
    dbg.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => { });
}

const keepDebugger = (s) => !!(s && (s.persistent || s.dialogMode || s.emulating));

async function withDebugger(tabId, fn) {
    const had = dbg.has(tabId);
    await attach(tabId);
    const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p || {});
    try {
        return await fn(send);
    } finally {
        const s = dbg.get(tabId);
        if (!had && !keepDebugger(s)) await detach(tabId);
    }
}

chrome.debugger.onDetach.addListener((src) => dbg.delete(src.tabId));

const remoteToText = (a) =>
    a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description || a.unserializableValue || a.type;

chrome.debugger.onEvent.addListener((src, method, p) => {
    const s = dbg.get(src.tabId);
    if (!s) return;
    if (method === "Page.javascriptDialogOpening") {
        const entry = { t: Date.now(), type: p.type, message: p.message, defaultPrompt: p.defaultPrompt || "", handled: null };
        s.dialogs.push(entry);
        if (s.dialogs.length > 50) s.dialogs.shift();
        if (s.dialogMode) {
            const accept = s.dialogMode.endsWith("accept");
            const once = s.dialogMode.startsWith("once-");
            const promptText = s.dialogPrompt;
            entry.handled = accept ? "accepted" : "dismissed";
            if (once) {
                s.dialogMode = null;
                s.dialogPrompt = undefined;
            }
            chrome.debugger
                .sendCommand({ tabId: src.tabId }, "Page.handleJavaScriptDialog", {
                    accept,
                    ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
                })
                .then(() => {
                    if (once && !keepDebugger(s)) detach(src.tabId);
                })
                .catch(() => { });
        }
        return;
    }
    if (!s.persistent) return;
    const pushC = (entry) => {
        s.console.push(entry);
        if (s.console.length > MAX_CONSOLE) s.console.shift();
    };
    if (method === "Runtime.consoleAPICalled") {
        const fr = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
        pushC({ t: Date.now(), level: p.type, text: (p.args || []).map(remoteToText).join(" "), src: fr ? `${fr.url}:${fr.lineNumber + 1}` : "" });
    } else if (method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails || {};
        pushC({ t: Date.now(), level: "exception", text: (d.exception && d.exception.description) || d.text, src: d.url ? `${d.url}:${d.lineNumber + 1}` : "" });
    } else if (method === "Log.entryAdded") {
        const e = p.entry || {};
        pushC({ t: Date.now(), level: e.level, text: e.text, src: e.url || e.source || "" });
    } else if (method === "Network.requestWillBeSent") {
        s.net.set(p.requestId, { id: p.requestId, t: Date.now(), method: p.request.method, url: p.request.url, type: p.type, status: null });
        if (s.net.size > MAX_NET) s.net.delete(s.net.keys().next().value);
    } else if (method === "Network.responseReceived") {
        const r = s.net.get(p.requestId);
        if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, type: p.type || r.type });
    } else if (method === "Network.loadingFinished") {
        const r = s.net.get(p.requestId);
        if (r) r.size = p.encodedDataLength;
    } else if (method === "Network.loadingFailed") {
        const r = s.net.get(p.requestId);
        if (r) Object.assign(r, { failed: p.errorText || "failed", status: r.status || 0 });
    }
});

const KEYMAP = {
    enter: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32, " "],
    arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    arrowright: ["ArrowRight", "ArrowRight", 39], home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};

function parseCombo(combo) {
    const parts = String(combo).split("+").map((x) => x.trim()).filter(Boolean);
    let k = parts.pop() || "";
    let mods = 0;
    for (const p of parts) {
        if (/^alt$/i.test(p)) mods |= 1;
        else if (/^(ctrl|control)$/i.test(p)) mods |= 2;
        else if (/^(meta|cmd|win)$/i.test(p)) mods |= 4;
        else if (/^shift$/i.test(p)) mods |= 8;
    }
    let key, code, vk, text;
    const m = KEYMAP[k.toLowerCase()];
    if (m) [key, code, vk, text] = m;
    else if (/^f([1-9]|1[0-2])$/i.test(k)) {
        key = code = k.toUpperCase();
        vk = 111 + Number(k.slice(1));
    } else if (k.length === 1) {
        const up = k.toUpperCase();
        key = mods & 8 ? up : k;
        if (/[a-z]/i.test(k)) {
            code = `Key${up}`;
            vk = up.charCodeAt(0);
        } else if (/\d/.test(k)) {
            code = `Digit${k}`;
            vk = k.charCodeAt(0);
        } else {
            code = "";
            vk = 0;
        }
        text = key;
    } else throw bad(`Key tidak dikenal: ${k}`);
    if (mods & (1 | 2 | 4)) text = undefined; // dengan Ctrl/Alt/Meta tidak menghasilkan karakter
    return { key, code, vk, text, mods };
}

// Input trusted (CDP Input.*) jalan juga di tab background berkat attach-dulu + focus emulation
// (lihat withInput). --activate = opsi lama: aktifkan tab sebentar lalu kembalikan fokus user.
async function inputVisible(tabId, flags, fn) {
    const t = await chrome.tabs.get(tabId);
    if (t.active || !truthy(flags.activate)) return fn();
    return withTabVisible(tabId, () => fn());
}

// Attach dulu (bar "debugging" bikin layout geser), aktifkan focus emulation
// (window Brave mungkin tidak fokus di OS), tunggu 2 frame, baru kirim input.
async function withInput(tabId, fn) {
    return withDebugger(tabId, async (send) => {
        await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => { });
        // rAF tidak jalan di tab tersembunyi -> batasi 300ms.
        await Promise.race([
            chrome.scripting
                .executeScript({ target: { tabId }, func: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))) })
                .catch(() => { }),
            sleep(300),
        ]);
        try {
            return await fn(send);
        } finally {
            await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => { });
        }
    });
}

async function cdpClick(tabId, flags, o, { button = "left", clickCount = 1 } = {}) {
    if (flags.frame !== undefined) throw bad("--cdp click belum mendukung --frame.");
    const buttons = button === "right" ? 2 : 1;
    return inputVisible(tabId, flags, () =>
        withInput(tabId, async (send) => {
            const r = await dom(tabId, flags, "rect", o);
            const x = r.x + r.w / 2;
            const y = r.y + r.h / 2;
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            for (let c = 1; c <= clickCount; c++) {
                await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: c });
                await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c });
            }
            return { ok: true, trusted: true, button, clickCount, x: Math.round(x), y: Math.round(y) };
        })
    );
}

async function cdpDrag(tabId, flags, fromSel, toSel) {
    if (flags.frame !== undefined) throw bad("--cdp drag belum mendukung --frame.");
    return inputVisible(tabId, flags, () =>
        withInput(tabId, async (send) => {
            const a = await dom(tabId, flags, "rect", { sel: fromSel });
            const b = await dom(tabId, flags, "rect", { sel: toSel, scroll: false });
            const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2;
            const x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 5; i++) {
                const k = i / 5;
                await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + (x2 - x1) * k, y: y1 + (y2 - y1) * k, button: "left", buttons: 1 });
            }
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
            return { ok: true, trusted: true, from: [Math.round(x1), Math.round(y1)], to: [Math.round(x2), Math.round(y2)] };
        })
    );
}

async function cdpKey(tabId, combo, flags = {}) {
    const k = parseCombo(combo);
    return inputVisible(tabId, flags, () =>
        withInput(tabId, async (send) => {
            const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.mods };
            await send("Input.dispatchKeyEvent", k.text ? { ...base, type: "keyDown", text: k.text, unmodifiedText: k.text } : { ...base, type: "rawKeyDown" });
            await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
            return { ok: true, trusted: true, key: k.key, modifiers: k.mods };
        })
    );
}

async function cdpEval(tabId, src) {
    return withDebugger(tabId, async (send) => {
        const r = await send("Runtime.evaluate", {
            expression: src,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
            replMode: true,
            allowUnsafeEvalBlockedByCSP: true,
        });
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            throw bad((d.exception && d.exception.description) || d.text || "eval error");
        }
        const v = r.result;
        return v.value !== undefined ? v.value : v.description !== undefined ? v.description : null;
    });
}

const cdpSelector = (sel) => (/^@\d+$/.test(sel) ? `[data-bb-ref="${sel.slice(1)}"]` : sel);

// ------------------------------------------------------------------ eval (MAIN world)
async function mainEval(tabId, src) {
    await ensureInjectable(tabId);
    const out = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [src],
        func: async (code) => {
            const ser = (v, d = 0) => {
                if (v === undefined) return null;
                if (typeof Element !== "undefined" && v instanceof Element) return v.outerHTML.slice(0, 3000);
                if (typeof NodeList !== "undefined" && (v instanceof NodeList || v instanceof HTMLCollection)) return Array.from(v).map((x) => ser(x, d + 1));
                if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
                try {
                    return JSON.parse(JSON.stringify(v));
                } catch {
                    return String(v);
                }
            };
            const isCsp = (m) => /unsafe-eval|Content Security Policy|EvalError/i.test(m);
            try {
                let v;
                try {
                    v = (0, eval)(code);
                } catch (e) {
                    // Top-level await -> bungkus jadi async. Coba sebagai ekspresi dulu (hasil otomatis
                    // dikembalikan), kalau bukan ekspresi baru sebagai blok statement (pakai `return`).
                    if (!(e instanceof SyntaxError && /await/.test(code))) throw e;
                    try {
                        v = (0, eval)(`(async () => (\n${code}\n))()`);
                    } catch {
                        v = (0, eval)(`(async () => {\n${code}\n})()`);
                    }
                }
                if (v && typeof v.then === "function") v = await v;
                return { ok: true, value: ser(v) };
            } catch (e) {
                const msg = String((e && e.message) || e);
                return { ok: false, error: msg, csp: isCsp(msg) || (e && e.name === "EvalError") };
            }
        },
    });
    return out[0] ? out[0].result : { ok: false, error: "tidak ada hasil" };
}

// ------------------------------------------------------------------ screenshot
async function withTabVisible(tabId, fn) {
    const t = await chrome.tabs.get(tabId);
    let restore = null;
    if (!t.active) {
        const [cur] = await chrome.tabs.query({ active: true, windowId: t.windowId });
        restore = cur ? cur.id : null;
        await chrome.tabs.update(tabId, { active: true });
        // Tunggu renderer benar-benar visible + 2 frame, baru kirim input/capture.
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
            const r = await chrome.scripting
                .executeScript({
                    target: { tabId },
                    func: () =>
                        document.visibilityState === "visible"
                            ? new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true))))
                            : false,
                })
                .catch(() => null);
            if (r && r[0] && r[0].result === true) break;
            await sleep(100);
        }
    }
    try {
        return await fn(t);
    } finally {
        if (restore) await chrome.tabs.update(restore, { active: true }).catch(() => { });
    }
}

async function blobToDataUrl(b) {
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${b.type};base64,${btoa(s)}`;
}

async function crop(dataUrl, r, format, quality) {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = bmp.width / r.vw; // pixel gambar per CSS px
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(r.vw, r.x + r.w);
    const y1 = Math.min(r.vh, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) throw bad("Elemen di luar viewport.");
    const sx = Math.round(x0 * scale);
    const sy = Math.round(y0 * scale);
    const sw = Math.max(1, Math.round((x1 - x0) * scale));
    const sh = Math.max(1, Math.round((y1 - y0) * scale));
    const c = new OffscreenCanvas(sw, sh);
    c.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await c.convertToBlob({ type: format === "jpeg" ? "image/jpeg" : "image/png", quality: quality / 100 });
    return blobToDataUrl(blob);
}

async function shot(tabId, flags) {
    const format = truthy(flags.jpeg) || truthy(flags.jpg) ? "jpeg" : "png";
    const quality = Number(flags.quality || 80);
    const t0 = await chrome.tabs.get(tabId);
    if (BLOCKED_SCHEME.test(t0.url || "") && (flags.selector || truthy(flags.full))) throw bad("Tidak bisa shot --selector/--full di halaman internal.");
    let rect = null;
    if (flags.selector && flags.selector !== true) rect = await dom(tabId, flags, "rect", { sel: String(flags.selector) });
    const full = truthy(flags.full);
    const q = format === "jpeg" ? quality : undefined;

    // Tab aktif & bukan full page: captureVisibleTab biasa (tanpa debugger).
    if (t0.active && !full) {
        let img = await chrome.tabs.captureVisibleTab(t0.windowId, { format, quality: q });
        if (rect) img = await crop(img, rect, format, quality);
        return { dataUrl: img, tabId, url: t0.url, title: t0.title, note: rect ? `elemen ${flags.selector}` : "viewport" };
    }

    // Mode lama (opt-in): aktifkan tab sebentar lalu kembalikan.
    if (truthy(flags.activate) && !full) {
        let img = await withTabVisible(tabId, (t) => chrome.tabs.captureVisibleTab(t.windowId, { format, quality: q }));
        if (rect) img = await crop(img, rect, format, quality);
        return { dataUrl: img, tabId, url: t0.url, title: t0.title, note: "viewport (tab diaktifkan sebentar)" };
    }

    // Tab background / full page: CDP, TANPA memindahkan fokus user.
    // captureBeyondViewport memaksa render ulang -> andal di tab tersembunyi (capture viewport biasa
    // bisa nunggu frame yang tidak pernah datang). Area dipilih lewat clip (koordinat halaman, CSS px).
    const img = await withDebugger(tabId, async (send) => {
        const m = await send("Page.getLayoutMetrics");
        const vv = m.cssVisualViewport || m.visualViewport;
        let clip;
        if (full) {
            const cs = m.cssContentSize || m.contentSize;
            clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(Math.ceil(cs.height), 16000) };
        } else if (rect) {
            clip = { x: vv.pageX + rect.x, y: vv.pageY + rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h) };
        } else {
            clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
        }
        const params = { format, quality: q, captureBeyondViewport: true, clip: { ...clip, scale: 1 } };
        const attempt = () =>
            Promise.race([
                send("Page.captureScreenshot", params),
                sleep(Number(flags.shotTimeout || 6000)).then(() => {
                    throw bad("Timeout screenshot tab background via CDP. Coba: shot --activate (tab diaktifkan sebentar).");
                }),
            ]);
        let r;
        try {
            r = await attempt();
        } catch {
            r = await attempt(); // sekali retry
        }
        return `data:image/${format};base64,${r.data}`;
    });
    return {
        dataUrl: img,
        tabId,
        url: t0.url,
        title: t0.title,
        note: `${full ? "full page" : rect ? `elemen ${flags.selector}` : "viewport"} (CDP${t0.active ? "" : ", tab background, fokus user tidak dipindah"})`,
    };
}

// ------------------------------------------------------------------ handlers
async function handle(cmd, params = {}) {
    const args = params.args || [];
    const flags = params.flags || {};
    const idx = Number(flags.index || 0);
    const text = flags.text && flags.text !== true ? String(flags.text) : undefined;

    // Command yang butuh tab target.
    const target = async () => {
        const id = await tabIdOf(flags);
        await guard(cmd, id, flags);
        return id;
    };

    switch (cmd) {
        case "ping":
        case "status": {
            const tabs = await chrome.tabs.query({});
            return { ok: true, ext: VERSION, tabs: tabs.length, transport: "websocket", cdpAttached: [...dbg.keys()] };
        }

        case "reload-ext":
            setTimeout(() => chrome.runtime.reload(), 200);
            return { reloading: true, version: VERSION };

        case "tabs": {
            const tabs = await chrome.tabs.query({});
            const groups = await chrome.tabGroups.query({}).catch(() => []);
            const gmap = new Map(groups.map((g) => [g.id, g.title]));
            let out = tabs.map((t) => {
                const real = t.groupId === -1 || t.groupId === undefined ? null : gmap.get(t.groupId) || null;
                return {
                    id: t.id,
                    windowId: t.windowId,
                    active: !!t.active,
                    pinned: !!t.pinned,
                    groupId: t.groupId === -1 || t.groupId === undefined ? null : t.groupId,
                    group: real || virtualGroups.get(t.id) || null,
                    title: t.title,
                    url: t.url,
                };
            });
            if (truthy(flags["all-sessions"])) {
                const base = String(flags.__guardGroup || "Antigravity");
                out = out.filter((t) => isAgentGroupTitle(t.group, base));
            } else if (typeof flags.group === "string") {
                out = out.filter((t) => t.group === flags.group);
            }
            return out;
        }

        case "closegroup":
        case "close-group": {
            const allSess = truthy(flags["all-sessions"]);
            const base = String(flags.__guardGroup || "Antigravity");
            const title = String(args[0] || flags.group || "");
            if (!allSess && !title) throw bad('Butuh nama group: close-group "Nama"');
            const groups = await chrome.tabGroups.query({}).catch(() => []);
            const matchTitle = (t) => (allSess ? isAgentGroupTitle(t, base) : t === title);
            const gids = new Set(groups.filter((g) => matchTitle(g.title)).map((g) => g.id));
            const targets = (await chrome.tabs.query({}))
                .filter((t) => gids.has(t.groupId) || matchTitle(virtualGroups.get(t.id)))
                .map((t) => t.id);
            const label = allSess ? `${base} + ${base}-*` : title;
            if (!gids.size && !targets.length) return { closed: [], count: 0, group: label, note: `group "${label}" tidak ada` };
            for (const id of targets) {
                virtualGroups.delete(id);
                if (dbg.has(id)) await detach(id);
            }
            if (targets.length) await chrome.tabs.remove(targets);
            return { closed: targets, count: targets.length, group: label };
        }

        case "frames": {
            const id = await tabIdOf(flags);
            const frames = await chrome.webNavigation.getAllFrames({ tabId: id });
            return (frames || []).map((f) => ({ frameId: f.frameId, parent: f.parentFrameId, url: f.url }));
        }

        case "active": {
            const t = await chrome.tabs.get(await activeTabId());
            return { id: t.id, windowId: t.windowId, active: true, title: t.title, url: t.url, status: t.status, group: await groupTitleOf(t) };
        }

        case "goto":
        case "open": {
            const url = args[0] || flags.url;
            if (!url) throw bad("Butuh URL.");
            const asNew = cmd === "open" || truthy(flags.new);
            let id;
            let groupId;
            if (asNew) {
                const t = await chrome.tabs.create({ url, active: truthy(flags.foreground) });
                id = t.id;
                groupId = await applyGroup(id, flags);
            } else {
                id = await target();
                await chrome.tabs.update(id, { url });
            }
            if (!truthy(flags.nowait)) await waitComplete(id, Number(flags.timeout || 25000));
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url, title: t.title, status: t.status, groupId, group: await groupTitleOf(t) };
        }

        case "new": {
            const url = args[0] || flags.url || "about:blank";
            const t = await chrome.tabs.create({ url, active: truthy(flags.foreground) });
            const groupId = await applyGroup(t.id, flags);
            if (url !== "about:blank" && !truthy(flags.nowait)) await waitComplete(t.id, Number(flags.timeout || 25000));
            const tab = await chrome.tabs.get(t.id);
            return { tabId: tab.id, url: tab.url, title: tab.title, groupId, group: await groupTitleOf(tab) };
        }

        case "close": {
            const id = flags.tabId !== undefined ? Number(flags.tabId) : args[0] !== undefined ? Number(args[0]) : await activeTabId();
            await guard(cmd, id, flags);
            if (dbg.has(id)) await detach(id);
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
            const id = await target();
            await chrome.tabs.reload(id, { bypassCache: truthy(flags.hard) });
            if (!truthy(flags.nowait)) await waitComplete(id, Number(flags.timeout || 25000));
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url, status: t.status };
        }

        case "back":
        case "forward": {
            const id = await target();
            if (cmd === "back") await chrome.tabs.goBack(id);
            else await chrome.tabs.goForward(id);
            if (!truthy(flags.nowait)) await waitComplete(id, 15000);
            const t = await chrome.tabs.get(id);
            return { tabId: t.id, url: t.url };
        }

        case "url":
        case "title": {
            const t = await chrome.tabs.get(await tabIdOf(flags));
            return { url: t.url, title: t.title };
        }

        case "eval": {
            const code = args.join(" ");
            if (!code) throw bad("Butuh ekspresi (atau --file path / eval - dari stdin).");
            const id = await target();
            if (truthy(flags.cdp)) return cdpEval(id, code);
            if (truthy(flags.isolated)) {
                // ISOLATED world: lihat DOM saja (tanpa JS halaman).
                const out = await chrome.scripting.executeScript({
                    target: { tabId: id },
                    args: [code],
                    func: async (c) => {
                        try {
                            let v = (0, eval)(c);
                            if (v && typeof v.then === "function") v = await v;
                            return { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
                        } catch (e) {
                            return { ok: false, error: String((e && e.message) || e) };
                        }
                    },
                });
                const r = out[0] && out[0].result;
                if (!r || !r.ok) throw bad(r ? r.error : "eval gagal");
                return r.value;
            }
            const r = await mainEval(id, code);
            if (r.ok) return r.value;
            if (r.csp && !truthy(flags["no-cdp"])) {
                // CSP halaman memblokir eval -> pakai CDP Runtime.evaluate (tembus CSP).
                return cdpEval(id, code);
            }
            throw bad(r.error + (r.csp ? " (diblok CSP; coba tanpa --no-cdp)" : ""));
        }

        case "text":
        case "html": {
            const id = await tabIdOf(flags);
            const max = flags.max !== undefined ? Number(flags.max) : 20000;
            return dom(id, flags, cmd, { sel: args[0] || "", text, index: idx, max });
        }

        case "count": {
            const id = await tabIdOf(flags);
            return dom(id, flags, "count", { sel: args[0] });
        }

        case "attr": {
            const id = await tabIdOf(flags);
            return dom(id, flags, "attr", { sel: args[0], name: args[1], index: idx });
        }

        case "snapshot": {
            const id = await tabIdOf(flags);
            return dom(id, flags, "snapshot", {
                max: flags.max ? Number(flags.max) : 250,
                viewport: truthy(flags.viewport),
                noHeadings: truthy(flags["no-headings"]),
            });
        }

        case "links": {
            const id = await tabIdOf(flags);
            return dom(id, flags, "links", { max: flags.max ? Number(flags.max) : 200 });
        }

        case "forms": {
            const id = await tabIdOf(flags);
            return dom(id, flags, "forms", {});
        }

        case "click":
        case "dblclick":
        case "rightclick": {
            const id = await target();
            const o = { sel: args[0] || "", text, index: idx };
            const isRight = cmd === "rightclick" || flags.button === "right";
            const isDouble = cmd === "dblclick" || truthy(flags.double);
            if (truthy(flags.cdp)) {
                return cdpClick(id, flags, o, { button: isRight ? "right" : "left", clickCount: isDouble ? 2 : 1 });
            }
            return dom(id, flags, isRight ? "rightclick" : isDouble ? "dblclick" : "click", o);
        }

        case "drag": {
            const [fromSel, toSel] = args;
            if (!fromSel || !toSel) throw bad("Pakai: drag <selector-asal> <selector-tujuan>");
            const id = await target();
            if (truthy(flags.cdp)) return cdpDrag(id, flags, fromSel, toSel);
            return dom(id, flags, "drag", { from: fromSel, to: toSel });
        }

        case "hover": {
            const id = await target();
            const o = { sel: args[0] || "", text, index: idx };
            if (truthy(flags.cdp)) {
                return inputVisible(id, flags, async () => {
                    const r = await dom(id, flags, "rect", o);
                    await withDebugger(id, (send) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + r.w / 2, y: r.y + r.h / 2 }));
                    return { ok: true, trusted: true };
                });
            }
            return dom(id, flags, "hover", o);
        }

        case "focus": {
            const id = await target();
            return dom(id, flags, "focus", { sel: args[0], text, index: idx, clear: truthy(flags.clear) });
        }

        case "fill":
        case "type": {
            const [sel, value = ""] = args;
            if (!sel) throw bad("Butuh selector.");
            const id = await target();
            const append = truthy(flags.append);
            if (truthy(flags.cdp)) {
                return inputVisible(id, flags, async () => {
                    await dom(id, flags, "focus", { sel, index: idx, clear: !append });
                    await withDebugger(id, (send) => send("Input.insertText", { text: String(value) }));
                    return { ok: true, trusted: true, inserted: String(value).length };
                });
            }
            return dom(id, flags, cmd, { sel, value, append, index: idx });
        }

        case "select": {
            const id = await target();
            return dom(id, flags, "select", { sel: args[0], value: args[1], index: idx });
        }

        case "check":
        case "uncheck": {
            const id = await target();
            return dom(id, flags, "check", { sel: args[0], want: cmd === "check", index: idx });
        }

        case "key": {
            const combo = args[0];
            if (!combo) throw bad("Butuh kombinasi, mis. Control+a");
            const id = await target();
            if (truthy(flags.cdp)) {
                if (args[1]) await dom(id, flags, "focus", { sel: args[1] });
                return cdpKey(id, combo, flags);
            }
            return dom(id, flags, "key", { combo, sel: args[1] || "" });
        }

        case "scroll": {
            const id = await target();
            return dom(id, flags, "scroll", { target: args[0] || "bottom" });
        }

        case "wait": {
            const ms = Number(args[0] || flags.ms || 1000);
            await sleep(ms);
            return { waited: ms };
        }

        case "waitfor":
        case "waitFor": {
            const sel = args[0] || "";
            if (!sel && !text) throw bad('Butuh selector atau --text "...".');
            const id = await tabIdOf(flags);
            const timeout = Number(flags.timeout || 15000);
            const t0 = Date.now();
            // Ulangi kalau konteks halaman hilang karena navigasi di tengah jalan.
            while (Date.now() - t0 < timeout) {
                try {
                    const r = await dom(id, flags, "waitFor", { sel, text, gone: truthy(flags.gone), timeout: timeout - (Date.now() - t0) });
                    if (r && r.found) return { found: true, waitedMs: Date.now() - t0 };
                    break;
                } catch (e) {
                    if (e.__bridge && !/Frame|context|unloaded|removed|No tab/i.test(e.message)) throw e;
                    await sleep(300);
                }
            }
            throw bad(`Timeout ${timeout}ms nunggu: ${sel || `text "${text}"`}${truthy(flags.gone) ? " hilang" : ""}`);
        }

        case "waiturl":
        case "waitUrl": {
            const pat = String(args[0] || "");
            if (!pat) throw bad("Butuh pola URL (substring atau /regex/).");
            const re = /^\/.*\/[a-z]*$/i.test(pat) ? new RegExp(pat.slice(1, pat.lastIndexOf("/")), pat.slice(pat.lastIndexOf("/") + 1)) : null;
            const id = await tabIdOf(flags);
            const timeout = Number(flags.timeout || 15000);
            const t0 = Date.now();
            while (Date.now() - t0 < timeout) {
                const t = await chrome.tabs.get(id);
                if (re ? re.test(t.url) : (t.url || "").includes(pat)) return { url: t.url, waitedMs: Date.now() - t0 };
                await sleep(200);
            }
            throw bad(`Timeout ${timeout}ms nunggu URL: ${pat}`);
        }

        case "shot": {
            const id = await tabIdOf(flags);
            return shot(id, flags);
        }

        case "pdf": {
            const id = await tabIdOf(flags);
            const t0 = await ensureInjectable(id);
            const pdfBase64 = await withDebugger(id, async (send) => {
                const r = await send("Page.printToPDF", {
                    printBackground: !truthy(flags["no-bg"]),
                    landscape: truthy(flags.landscape),
                    preferCSSPageSize: true,
                });
                return r.data;
            });
            return { pdfBase64, tabId: id, url: t0.url, title: t0.title };
        }

        case "dialog": {
            const act = String(args[0] || "status").toLowerCase();
            const promptText = args[1] !== undefined ? String(args[1]) : flags.prompt !== undefined && flags.prompt !== true ? String(flags.prompt) : undefined;
            const id = act === "status" ? await tabIdOf(flags) : await target();
            if (act === "status") {
                const s = dbg.get(id);
                return { tabId: id, mode: s ? s.dialogMode : null, dialogs: s ? s.dialogs : [] };
            }
            if (act === "off") {
                const s = dbg.get(id);
                if (s) {
                    s.dialogMode = null;
                    s.dialogPrompt = undefined;
                    if (!keepDebugger(s)) await detach(id);
                }
                return { ok: true, tabId: id, mode: null };
            }
            if (["once-accept", "once-dismiss", "auto-accept", "auto-dismiss"].includes(act)) {
                const s = await attach(id);
                s.dialogMode = act;
                s.dialogPrompt = promptText;
                await chrome.debugger.sendCommand({ tabId: id }, "Page.enable", {});
                return { ok: true, tabId: id, mode: act };
            }
            if (act === "accept" || act === "dismiss") {
                return withDebugger(id, async (send) => {
                    await send("Page.enable");
                    await send("Page.handleJavaScriptDialog", {
                        accept: act === "accept",
                        ...(promptText !== undefined ? { promptText } : {}),
                    });
                    return { ok: true, handled: act };
                });
            }
            throw bad(`Aksi dialog tidak dikenal: ${act}. Pakai: accept|dismiss|once-accept|once-dismiss|auto-accept|auto-dismiss|off|status`);
        }

        case "cookies": {
            const sub = String(args[0] || "list").toLowerCase();
            const id = await target();
            const t0 = await ensureInjectable(id);
            return withDebugger(id, async (send) => {
                if (sub === "set") {
                    const [, name, value = ""] = args;
                    if (!name) throw bad("Pakai: cookies set <name> <value>");
                    const params = {
                        url: t0.url,
                        name: String(name),
                        value: String(value),
                        path: typeof flags.path === "string" ? flags.path : "/",
                        secure: truthy(flags.secure),
                        httpOnly: truthy(flags.httpOnly) || truthy(flags["http-only"]),
                    };
                    if (typeof flags.sameSite === "string") params.sameSite = flags.sameSite;
                    if (typeof flags.domain === "string") params.domain = flags.domain;
                    const r = await send("Network.setCookie", params);
                    if (!r.success) throw bad("Gagal set cookie (cek secure/sameSite/domain).");
                    return { ok: true, name, url: t0.url };
                }
                if (sub === "delete" || sub === "remove") {
                    const name = args[1];
                    if (!name) throw bad("Pakai: cookies delete <name>");
                    await send("Network.deleteCookies", { name: String(name), url: t0.url });
                    return { ok: true, deleted: name };
                }
                if (sub === "clear") {
                    const { cookies } = await send("Network.getCookies", { urls: [t0.url] });
                    for (const c of cookies) await send("Network.deleteCookies", { name: c.name, url: t0.url, domain: c.domain, path: c.path });
                    return { ok: true, cleared: cookies.length };
                }
                const { cookies } = await send("Network.getCookies", { urls: [t0.url] });
                return cookies.map((c) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    httpOnly: !!c.httpOnly,
                    secure: !!c.secure,
                    sameSite: c.sameSite || null,
                    session: !!c.session,
                    expires: c.session ? null : c.expires,
                }));
            });
        }

        case "storage": {
            const sub = String(args[0] || "list").toLowerCase();
            const id = await target();
            const area = truthy(flags.sessionStorage) || truthy(flags["session-storage"]) ? "session" : "local";
            if (["list", "get", "set", "remove", "clear"].includes(sub)) {
                return dom(id, flags, "storage", { area, action: sub, key: args[1], value: args[2] });
            }
            throw bad("Pakai: storage [list|get <k>|set <k> <v>|remove <k>|clear] [--session-storage]");
        }

        case "emulate": {
            const presetName = String(args[0] || "").toLowerCase();
            const id = await target();
            const scheme = flags["color-scheme"] || flags.colorScheme;
            if (presetName === "reset" || presetName === "off") {
                const s = dbg.get(id);
                if (s) {
                    const send = (m, p) => chrome.debugger.sendCommand({ tabId: id }, m, p || {}).catch(() => { });
                    await send("Emulation.clearDeviceMetricsOverride");
                    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
                    await send("Emulation.setEmulatedMedia", { features: [] });
                    await send("Emulation.setUserAgentOverride", { userAgent: "" });
                    s.emulating = false;
                    if (!keepDebugger(s)) await detach(id);
                }
                return { ok: true, tabId: id, emulating: false };
            }
            const preset = presetName ? DEVICES[presetName] : null;
            if (presetName && !preset) {
                throw bad(`Preset tidak dikenal: ${presetName}. Pakai: iphone | pixel | ipad | desktop | reset (atau --width W --height H).`);
            }
            const width = Number(flags.width || (preset && preset.width) || 0);
            const height = Number(flags.height || (preset && preset.height) || 0);
            const dpr = Number(flags.dpr || (preset && preset.dpr) || 1);
            const mobile = flags.mobile !== undefined ? truthy(flags.mobile) : !!(preset && preset.mobile);
            const ua = typeof flags.ua === "string" ? flags.ua : preset ? preset.ua : undefined;
            if ((!width || !height) && !scheme) {
                throw bad("Pakai: emulate iphone|pixel|ipad|desktop|reset, atau --width W --height H, atau --color-scheme dark|light.");
            }
            const s = await attach(id);
            s.emulating = true;
            const send = (m, p) => chrome.debugger.sendCommand({ tabId: id }, m, p || {});
            if (width && height) {
                // dontSetVisibleSize: true menjaga ukuran Aura view asli tab background tidak ketimpa 390x844,
                // jadi begitu `emulate reset` detach debugger, innerWidth langsung balik ke ukuran desktop asli.
                await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile, dontSetVisibleSize: true });
                await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
            }
            if (ua !== undefined) await send("Emulation.setUserAgentOverride", { userAgent: ua });
            if (typeof scheme === "string" && scheme) {
                await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
            }
            return {
                ok: true,
                tabId: id,
                preset: presetName || "custom",
                viewport: width && height ? { width, height, dpr, mobile } : null,
                colorScheme: typeof scheme === "string" ? scheme : null,
            };
        }

        case "upload": {
            const [sel, ...files] = args;
            if (!sel || !files.length) throw bad("Pakai: upload <selector input[type=file]> <file...>");
            const id = await target();
            return withDebugger(id, async (send) => {
                const { root } = await send("DOM.getDocument", { depth: 0 });
                const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: cdpSelector(sel) });
                if (!nodeId) throw bad(`Elemen tidak ketemu: ${sel}`);
                await send("DOM.setFileInputFiles", { nodeId, files });
                return { ok: true, files };
            });
        }

        case "capture": {
            const sub = String(args[0] || "status");
            const id = await tabIdOf(flags);
            if (sub === "start") {
                const s = await attach(id);
                s.persistent = true;
                const send = (m, p) => chrome.debugger.sendCommand({ tabId: id }, m, p || {});
                await send("Runtime.enable");
                await send("Log.enable");
                await send("Network.enable");
                return { capturing: true, tabId: id, note: "Brave menampilkan bar debugging sampai `capture stop`." };
            }
            if (sub === "stop") {
                await detach(id);
                return { capturing: false, tabId: id };
            }
            const s = dbg.get(id);
            return { capturing: !!(s && s.persistent), tabId: id, console: s ? s.console.length : 0, net: s ? s.net.size : 0 };
        }

        case "console": {
            const id = await tabIdOf(flags);
            const s = dbg.get(id);
            if (!s || !s.persistent) throw bad(`Belum capture di tab ${id}. Jalankan dulu: capture start --tabId ${id}`);
            let out = s.console.slice();
            // Default: buang log dari content script extension lain (noise).
            if (!truthy(flags.all)) out = out.filter((e) => !/^chrome-extension:\/\//.test(e.src || ""));
            if (flags.level && flags.level !== true) {
                const lv = String(flags.level).toLowerCase();
                out = out.filter((e) => (lv === "error" ? /error|exception|assert/.test(e.level) : e.level === lv));
            }
            if (flags.last) out = out.slice(-Number(flags.last));
            if (truthy(flags.clear)) s.console.length = 0;
            return out;
        }

        case "net": {
            const id = await tabIdOf(flags);
            const s = dbg.get(id);
            if (!s || !s.persistent) throw bad(`Belum capture di tab ${id}. Jalankan dulu: capture start --tabId ${id}`);
            if (flags.body && flags.body !== true) {
                const r = await chrome.debugger.sendCommand({ tabId: id }, "Network.getResponseBody", { requestId: String(flags.body) });
                const body = r.base64Encoded ? `[base64 ${r.body.length} char]` : r.body;
                const max = flags.max !== undefined ? Number(flags.max) : 20000;
                return max > 0 && body.length > max ? body.slice(0, max) + `\n…[dipotong: ${body.length} char]` : body;
            }
            let out = [...s.net.values()];
            if (flags.filter && flags.filter !== true) out = out.filter((r) => r.url.includes(String(flags.filter)));
            if (truthy(flags.failed)) out = out.filter((r) => r.failed || r.status >= 400);
            if (flags.last) out = out.slice(-Number(flags.last));
            if (truthy(flags.clear)) s.net.clear();
            return out;
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
            return { id: win.id, state: win.state, width: win.width, height: win.height, left: win.left, top: win.top, focused: win.focused };
        }

        default:
            throw bad(`Command tidak dikenal: ${cmd}`);
    }
}

async function runJob(job) {
    if (job.expiresAt && Date.now() > job.expiresAt) {
        return { id: job.id, ok: false, error: "Job kedaluwarsa (CLI sudah timeout), tidak dieksekusi." };
    }
    try {
        const result = await handle(job.cmd, job.params || {});
        return { id: job.id, ok: true, result };
    } catch (e) {
        return { id: job.id, ok: false, error: String((e && e.message) || e) };
    }
}

// ------------------------------------------------------------------ WebSocket transport
let ws = null;
let backoff = 1000;
let reconnectTimer = null;

function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(reconnectTimer);
    let sock;
    try {
        sock = new WebSocket(WS_URL);
    } catch {
        return scheduleReconnect();
    }
    ws = sock;
    sock.onopen = () => {
        backoff = 1000;
        setBadge("ON", "#16a34a");
        sock.send(JSON.stringify({ type: "hello", version: VERSION, id: chrome.runtime.id }));
    };
    sock.onmessage = async (ev) => {
        let m;
        try {
            m = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (m.type === "ping") return sock.readyState === 1 && sock.send('{"type":"pong"}');
        if (m.type === "job") {
            // Paralel: satu waitFor lama tidak memblokir command lain.
            const r = await runJob(m);
            if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "result", ...r }));
        }
    };
    sock.onclose = () => {
        if (ws === sock) ws = null;
        setBadge("OFF", "#dc2626");
        scheduleReconnect();
    };
    sock.onerror = () => { };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 3000); // localhost: retry cepat biar konek ulang < 3 detik setelah server nyala
}

// Heartbeat dari sisi extension (aktivitas WS menjaga service worker tetap hidup).
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"type":"hb"}');
}, 20000);

// Pesan internal dari Popup UI (hanya dari extension ini sendiri).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id || !msg) return false;
    (async () => {
        if (msg.type === "popup-state") {
            const base = "Antigravity";
            const tabs = await chrome.tabs.query({});
            const groups = await chrome.tabGroups.query({}).catch(() => []);
            const gmap = new Map(groups.map((g) => [g.id, { title: g.title, color: g.color }]));
            const byGroup = new Map();
            for (const t of tabs) {
                const info = t.groupId !== -1 && t.groupId !== undefined ? gmap.get(t.groupId) : null;
                const title = (info && info.title) || virtualGroups.get(t.id) || null;
                if (!isAgentGroupTitle(title, base)) continue;
                const cur = byGroup.get(title) || { title, color: (info && info.color) || "purple", count: 0 };
                cur.count++;
                byGroup.set(title, cur);
            }
            return {
                ok: true,
                connected: !!(ws && ws.readyState === WebSocket.OPEN),
                wsUrl: WS_URL,
                httpBase: WS_URL.replace(/^ws:/, "http:").replace(/\/ws$/, ""),
                extVersion: VERSION,
                extId: chrome.runtime.id,
                totalTabs: tabs.length,
                cdpAttached: [...dbg.keys()],
                agentGroups: [...byGroup.values()],
            };
        }
        if (msg.type === "popup-reconnect") {
            if (ws) {
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                ws = null;
            }
            backoff = 500;
            connect();
            await sleep(350);
            return { ok: true, connected: !!(ws && ws.readyState === WebSocket.OPEN) };
        }
        if (msg.type === "popup-close-group") {
            const flags = msg.all ? { "all-sessions": true, __guardGroup: "Antigravity" } : { group: msg.group, __guardGroup: "Antigravity" };
            return { ok: true, ...(await handle("close-group", { args: [], flags })) };
        }
        return { ok: false, error: "unknown message" };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener(connect);
connect();
try {
    chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
} catch {
    /* opsional */
}
