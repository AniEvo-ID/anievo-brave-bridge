#!/usr/bin/env node
/**
 * brave-bridge.mjs — Kontrol Brave yang SEDANG JALAN (tanpa close/relaunch), ala Claude in Chrome.
 *
 * Arsitektur (extension bridge):
 *   Brave (extension "AniEvo Brave Bridge") --long-poll--> server lokal ini
 *   CLI (file ini)  --HTTP-->  server  --relay-->  extension  -->  chrome.* API
 *
 * Setup sekali:
 *   1. Jalankan server:  npm run brave:bridge:serve     (atau: node %USERPROFILE%\.brave-bridge\brave-bridge.mjs serve)
 *   2. brave://extensions -> nyalakan Developer mode -> "Load unpacked"
 *      -> pilih folder: %USERPROFILE%\.brave-bridge\brave-extension
 *   Setelah itu Brave TIDAK perlu ditutup lagi.
 *
 * Pakai (server harus jalan):
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs status
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs tabs
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs goto http://localhost:4003/login
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs text "h1"
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs fill "input[name=email]" "anievo.id@gmail.com"
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs click "button[type=submit]"
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs shot
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs eval "document.title"
 *   node %USERPROFILE%\.brave-bridge\brave-bridge.mjs close-mine   (tutup tab buatan bridge)
 *
 * Zero dependency: cuma butuh Node >= 18 (fetch global).
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HOST = process.env.BRAVE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.BRAVE_BRIDGE_PORT || 8787);
const POLL_MS = 8000; // poll pendek biar service worker extension nggak idle
const CMD_TIMEOUT = Number(process.env.BRAVE_BRIDGE_TIMEOUT || 45000);
const ALIVE_MS = 45000; // extension dianggap hidup bila poll terakhir < ini
const ARTIFACT_DIR =
    process.env.BRAVE_CDP_ARTIFACTS || path.join(os.homedir(), ".brave-cdp", "artifacts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(__dirname, "brave-extension");

const EXT_HINT =
    "Extension belum konek ke bridge. Pastikan: (1) Brave sedang jalan, " +
    '(2) extension "AniEvo Brave Bridge" ter-load di brave://extensions ' +
    "(Developer mode -> Load unpacked -> folder tools/brave-extension).";

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
        positional.push(...argv.slice(i + 1));
        break;
    }
    if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
        else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
        else flags[a.slice(2)] = true;
    } else {
        positional.push(a);
    }
}
const cmd = (positional.shift() || "help").toLowerCase();

// ---------------------------------------------------------------- server mode
let seq = 0;

function readBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            if (!data) return resolve(null);
            try {
                resolve(JSON.parse(data));
            } catch {
                resolve(null);
            }
        });
        req.on("error", () => resolve(null));
    });
}

function startServer() {
    const queue = []; // perintah menunggu diambil extension
    const polls = []; // long-poll yang menggantung
    const waiters = new Map(); // id -> { resolve, timer }
    const mine = new Map(); // tabId -> { id, url, title, at } (tab yang DIBUKA oleh bridge)
    let lastPollAt = 0;

    const extAlive = () => Date.now() - lastPollAt < ALIVE_MS;

    // Catat tab baru yang dibuat bridge (open / new / goto --new).
    // goto TANPA --new memakai tab aktif -> JANGAN dicatat (bisa tab milik user).
    const createsNewTab = (lc, f) => lc === "open" || lc === "new" || (lc === "goto" && (f.new === true || f.new === "true"));
    function remember(result) {
        if (!result || typeof result !== "object") return;
        const raw = result.tabId !== undefined ? result.tabId : result.id;
        if (raw === undefined || raw === null) return;
        mine.set(String(raw), {
            id: Number(raw),
            url: result.url || "",
            title: result.title || "",
            groupId: result.groupId === undefined ? null : result.groupId,
            at: Date.now(),
        });
    }
    const forget = (id) => mine.delete(String(id));

    // Kirim satu job ke extension lewat poll/queue yang sudah ada.
    function relay(c, args, f, timeout) {
        const id = ++seq;
        const job = { id, cmd: c, params: { args, flags: f } };
        const wait = Number(timeout || f.timeout || CMD_TIMEOUT);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                waiters.delete(id);
                resolve({ ok: false, error: `Timeout ${wait}ms nunggu extension (tab sibuk / halaman chrome:// ?)` });
            }, wait);
            waiters.set(id, { resolve, timer });
            if (!deliver(job)) queue.push(job);
        });
    }

    const CORS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Cache-Control": "no-store",
    };
    const send = (res, code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            ...CORS,
        });
        res.end(body);
    };

    // Serahkan job ke poll yang menggantung; kalau tidak ada, taruh di queue.
    function deliver(job) {
        const p = polls.shift();
        if (p) {
            clearTimeout(p.timer);
            p.resolve(job);
            return true;
        }
        return false;
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        console.log(`[req] ${req.method} ${url.pathname} from ${req.socket.remoteAddress}:${req.socket.remotePort}`);

        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS);
            return res.end();
        }

        if (url.pathname === "/health") {
            return send(res, 200, {
                ok: true,
                ext: extAlive(),
                lastPollAgoMs: lastPollAt ? Date.now() - lastPollAt : null,
                queued: queue.length,
                pending: polls.length,
            });
        }

        // Extension long-poll di sini.
        if (url.pathname === "/poll") {
            lastPollAt = Date.now();
            if (queue.length) return send(res, 200, queue.shift());
            const p = {};
            p.timer = setTimeout(() => {
                const i = polls.indexOf(p);
                if (i >= 0) polls.splice(i, 1);
                send(res, 200, { idle: true });
            }, POLL_MS);
            p.resolve = (job) => send(res, 200, job);
            polls.push(p);
            return;
        }

        const body = await readBody(req);

        // Extension melaporkan hasil.
        if (url.pathname === "/result") {
            const { id, ok, result, error } = body || {};
            const w = waiters.get(id);
            if (w) {
                waiters.delete(id);
                clearTimeout(w.timer);
                w.resolve(ok ? { ok: true, result } : { ok: false, error: error || "extension error" });
            }
            return send(res, 200, { ok: true });
        }

        // CLI mengirim perintah.
        if (url.pathname === "/cmd") {
            const { cmd: c, args = [], flags: f = {}, timeout } = body || {};
            if (!c) return send(res, 400, { ok: false, error: "cmd kosong" });
            const lc = String(c).toLowerCase();

            // Perintah yang dikelola server (tanpa extension).
            if (lc === "mine" || lc === "tabs-mine") {
                return send(res, 200, { ok: true, result: [...mine.values()] });
            }

            if (!extAlive()) return send(res, 503, { ok: false, error: EXT_HINT, hint: EXT_DIR });

            // Tutup semua tab yang dibuka bridge. --dry-run cuma menampilkan.
            if (lc === "close-mine" || lc === "close-mine-all") {
                const items = [...mine.values()];
                if (f["dry-run"] === true || f["dry-run"] === "true" || f["dryRun"] === true) {
                    return send(res, 200, { ok: true, result: { dryRun: true, wouldClose: items } });
                }
                const closed = [];
                const failed = [];
                for (const t of items) {
                    const r = await relay("close", [t.id], { tabId: t.id }, timeout);
                    if (r.ok) {
                        forget(t.id);
                        closed.push(t.id);
                    } else {
                        failed.push({ id: t.id, error: r.error });
                    }
                }
                return send(res, 200, {
                    ok: true,
                    result: { closed, count: closed.length, failed, remaining: [...mine.values()] },
                });
            }

            const out = await relay(c, args, f, timeout);
            if (out.ok) {
                if (createsNewTab(lc, f)) remember(out.result);
                if (lc === "close" && out.result && out.result.closed !== undefined) forget(out.result.closed);
                // close-group: sinkronkan pelacakan tab bridge.
                if ((lc === "close-group" || lc === "closegroup") && out.result && Array.isArray(out.result.closed)) {
                    out.result.closed.forEach(forget);
                }
            }
            return send(res, out.ok ? 200 : 500, out);
        }

        if (url.pathname === "/") {
            return send(res, 200, {
                name: "brave-bridge",
                ext: extAlive(),
                endpoints: ["/health", "/poll", "/result", "/cmd"],
            });
        }

        return send(res, 404, { ok: false, error: "not found" });
    });

    server.listen(PORT, HOST, () => {
        console.log(`brave-bridge listening on http://${HOST}:${PORT}`);
        console.log(`Extension folder (Load unpacked): ${EXT_DIR}`);
        console.log("Extension status: menunggu konek... (badge extension jadi ON kalau sudah nyambung)");
    });
    server.on("error", (e) => {
        if (e.code === "EADDRINUSE") {
            console.error(`Port ${PORT} sudah dipakai. Mungkin server sudah jalan. Coba: node tools/brave-bridge.mjs status`);
        } else {
            console.error(String(e.message || e));
        }
        process.exit(1);
    });
}

// ---------------------------------------------------------------- CLI mode
function pretty(c, result) {
    if (c === "status") return JSON.stringify(result, null, 2);
    if (c === "mine" || c === "tabs-mine") {
        if (!Array.isArray(result) || !result.length) return "(tidak ada tab buatan bridge)";
        return result
            .map((t) => `[${t.id}]${t.groupId ? ` (group ${t.groupId})` : ""} ${t.title || "(no title)"}\n      ${t.url || ""}`)
            .join("\n");
    }
    if (c === "close-mine" || c === "close-mine-all") {
        if (result && result.dryRun) {
            const n = (result.wouldClose || []).length;
            return `DRY-RUN: akan menutup ${n} tab buatan bridge:\n` +
                (result.wouldClose || []).map((t) => `[${t.id}] ${t.url}`).join("\n");
        }
        return `Ditutup: ${result.count} tab` +
            (result.failed && result.failed.length ? `\nGagal: ${JSON.stringify(result.failed)}` : "") +
            `\nSisa tab bridge: ${(result.remaining || []).length}`;
    }
    if (c === "tabs" && Array.isArray(result)) {
        return result
            .sort((a, b) => Number(b.active) - Number(a.active))
            .map((t) => `${t.active ? "*" : " "} [${t.id}]${t.group ? ` <${t.group}>` : ""} ${t.title || "(no title)"}\n      ${t.url || ""}`)
            .join("\n");
    }
    if (c === "close-group" || c === "closegroup") {
        if (result && result.note) return `${result.note} (ditutup: 0)`;
        return `Group "${result.group}": ditutup ${result.count} tab` +
            (result.closed && result.closed.length ? ` [${result.closed.join(", ")}]` : "");
    }
    if (typeof result === "string") return result;
    return JSON.stringify(result, null, 2);
}

function ts() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function saveShot(result) {
    const m = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(result.dataUrl || "");
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : "png";
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const file = path.join(ARTIFACT_DIR, `shot-${ts()}.${ext}`);
    await writeFile(file, Buffer.from(m[2], "base64"));
    return file;
}

function printHelp() {
    console.log(`brave-bridge — kontrol Brave yang sedang jalan (tanpa close), ala Claude in Chrome.

Server:
  node %USERPROFILE%\\.brave-bridge\\brave-bridge.mjs serve    # jalankan bridge (biarkan hidup)

Info:
  status                                      # extension + jumlah tab
  tabs [--group "Nama"]                       # daftar semua tab (opsional: filter per tab group)
  active                                      # tab aktif
  url | title [--tabId N]
  window [--state normal|maximized|minimized|fullscreen] [--width W] [--height H]

Tab buatan bridge (bersih-bersih):
  mine                                        # daftar tab yang DIBUKA bridge (open/new/goto --new)
  close-mine [--dry-run]                      # tutup SEMUA tab buatan bridge (tab user tidak disentuh)
  close-group "Nama"                          # tutup HANYA tab di tab group tsb (per-automation)

Navigasi:
  goto <url> [--new] [--nowait] [--tabId N]   # tab aktif, atau tab baru dgn --new
  open <url>                                  # selalu tab baru
  new [url]  |  close [tabId]  |  activate <tabId>
  reload [--hard]  |  back  |  forward
  # opsi tab baru: --group "Nama" [--color blue] -> masukkan tab ke tab group (nama sama = reuse)

DOM:
  eval "<ekspresi JS>" [--isolated]
  text [selector]   |  html [selector]   |  count <selector>   |  attr <selector> <name>
  click <selector> [--index N] [--text "Label"]
  fill <selector> <value> [--index N]     # set value + event input/change (React aman)
  type <selector> <value> [--append]
  select <selector> <value>  |  check <selector>  |  uncheck <selector>
  key <Control+a> [selector]
  scroll [selector|top|bottom]
  wait <ms>   |  waitFor <selector> [--timeout ms]
  shot [--jpeg] [--quality 80] [--tabId N]   # screenshot area tampak

Batasan mode extension: console/net tidak ada (pakai tools/brave-cdp.mjs), shot = viewport saja,
key bersifat sintetis (shortcut native browser tidak terpicu).

Option global: --tabId N  --timeout ms`);
}

async function runCli() {
    if (cmd === "help" || flags.help) return printHelp();

    let res;
    try {
        res = await fetch(`http://${HOST}:${PORT}/cmd`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                cmd,
                args: positional,
                flags,
                timeout: Number(flags.timeout || CMD_TIMEOUT),
            }),
        });
    } catch {
        console.error(`Tidak bisa konek ke bridge (http://${HOST}:${PORT}). Server belum jalan?`);
        console.error("Jalankan dulu: npm run brave:bridge:serve");
        process.exit(2);
    }

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { ok: res.ok, result: text };
    }

    if (!json.ok) {
        console.error(`GAGAL: ${json.error || "unknown"}`);
        if (json.hint) console.error(`Extension folder: ${json.hint}`);
        process.exit(1);
    }

    if (cmd === "shot") {
        const file = await saveShot(json.result);
        console.log(`shot: ${file || "(gagal simpan)"}`);
        console.log(`tab: ${json.result.title} — ${json.result.url}`);
        console.log(`note: ${json.result.note}`);
        return;
    }

    console.log(pretty(cmd, json.result));
}

// ---------------------------------------------------------------- dispatch
if (cmd === "serve" || cmd === "server") {
    startServer();
} else {
    runCli();
}
