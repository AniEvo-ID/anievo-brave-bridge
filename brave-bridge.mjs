#!/usr/bin/env node
/**
 * brave-bridge.mjs v2 — kontrol Brave yang SEDANG JALAN (tanpa close/relaunch).
 *
 * Arsitektur:
 *   Extension "AniEvo Brave Bridge" --WebSocket (Origin chrome-extension://<id>)--> server ini
 *   CLI (file ini) --HTTP + X-Bridge-Token--> server --relay--> extension --> chrome.* API
 *
 * Keamanan:
 *   - Server cuma listen di 127.0.0.1, cek Host header (anti DNS-rebinding).
 *   - /cmd wajib token dari config.json (dibuat otomatis). Website tidak bisa baca token.
 *   - TIDAK ada header CORS; request dengan Origin http(s) (= website) langsung ditolak.
 *   - /ws cuma menerima Origin chrome-extension://<id> yang di-pin (trust-on-first-use).
 *
 * Zero dependency, Node >= 18.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const VERSION = "2.6.2";
const PROTOCOL = 2;
const HOST = "127.0.0.1";
const PORT = Number(process.env.BRAVE_BRIDGE_PORT || 8787);
const CMD_TIMEOUT = Number(process.env.BRAVE_BRIDGE_TIMEOUT || 45000);
const ARTIFACT_DIR = process.env.BRAVE_CDP_ARTIFACTS || path.join(os.homedir(), ".brave-cdp", "artifacts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/i.test(__dirname);
const STATE_DIR = process.env.BRAVE_BRIDGE_HOME
    ? path.resolve(process.env.BRAVE_BRIDGE_HOME)
    : IN_NODE_MODULES
      ? path.join(os.homedir(), ".brave-bridge")
      : __dirname;
const BUNDLED_EXT_DIR = path.join(__dirname, "brave-extension");
const EXT_DIR = path.join(STATE_DIR, "brave-extension");
const CONFIG_PATH = process.env.BRAVE_BRIDGE_CONFIG ? path.resolve(process.env.BRAVE_BRIDGE_CONFIG) : path.join(STATE_DIR, "config.json");
const LOG_PATH = path.join(STATE_DIR, "server.log");

function syncExtensionIfNeeded() {
    mkdirSync(STATE_DIR, { recursive: true });
    if (path.resolve(BUNDLED_EXT_DIR) !== path.resolve(EXT_DIR) && existsSync(BUNDLED_EXT_DIR)) {
        cpSync(BUNDLED_EXT_DIR, EXT_DIR, { recursive: true, force: true });
    }
    return EXT_DIR;
}
const SESSION_COLORS = ["blue", "cyan", "green", "orange", "pink", "yellow", "red", "purple"];

function cleanSession(s) {
    if (!s || s === true) return "";
    return String(s).trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

function sessionColor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return SESSION_COLORS[h % SESSION_COLORS.length];
}

const EXT_HINT =
    'Extension belum konek. Pastikan Brave jalan dan extension "AniEvo Brave Bridge" enabled di brave://extensions ' +
    "(kalau baru update file extension: klik Reload di kartu extension-nya).";

// ---------------------------------------------------------------- config
const DEFAULT_CONFIG = { defaultGroup: "Antigravity", defaultColor: "purple", guard: true, extId: null };

function loadConfig(create = false) {
    let cfg = {};
    if (existsSync(CONFIG_PATH)) {
        try {
            cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        } catch {
            cfg = {};
        }
    }
    let changed = false;
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
        if (!(k in cfg)) {
            cfg[k] = v;
            changed = true;
        }
    }
    if (!cfg.token && create) {
        cfg.token = crypto.randomBytes(24).toString("hex");
        changed = true;
    }
    if (changed && create) saveConfig(cfg);
    return cfg;
}

function saveConfig(cfg) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------- arg parsing
// Flag boolean murni: jangan "makan" argumen positional sesudahnya.
const BOOL_FLAGS = new Set(["new", "nowait", "background", "hard", "isolated", "cdp", "no-cdp", "append", "force", "clear", "gone",
    "full", "jpeg", "jpg", "viewport", "no-headings", "failed", "dry-run", "no-group", "json", "verbose", "reset-ext", "help", "all",
    "foreground", "activate", "all-sessions", "double", "landscape", "no-bg", "secure", "httpOnly", "http-only", "sessionStorage", "session-storage", "mobile"]);
const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
        positional.push(...argv.slice(i + 1));
        break;
    }
    if (a.startsWith("--") && a.length > 2) {
        const eq = a.indexOf("=");
        const name = eq !== -1 ? a.slice(2, eq) : a.slice(2);
        if (eq !== -1) flags[name] = a.slice(eq + 1);
        else if (!BOOL_FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[name] = argv[++i];
        else flags[name] = true;
    } else {
        positional.push(a);
    }
}
const cmd = (positional.shift() || "help").toLowerCase();

// ---------------------------------------------------------------- minimal WebSocket (RFC 6455)
function wsAccept(req, socket) {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = { socket, open: true, onmessage: null, onclose: null };
    let buf = Buffer.alloc(0);
    let frags = [];

    const frame = (op, payload) => {
        const len = payload.length;
        let head;
        if (len < 126) head = Buffer.from([0x80 | op, len]);
        else if (len < 65536) {
            head = Buffer.alloc(4);
            head[0] = 0x80 | op;
            head[1] = 126;
            head.writeUInt16BE(len, 2);
        } else {
            head = Buffer.alloc(10);
            head[0] = 0x80 | op;
            head[1] = 127;
            head.writeBigUInt64BE(BigInt(len), 2);
        }
        return Buffer.concat([head, payload]);
    };
    conn.send = (str) => {
        if (conn.open) socket.write(frame(0x1, Buffer.from(str)));
    };
    conn.close = () => {
        if (!conn.open) return;
        conn.open = false;
        try {
            socket.end(frame(0x8, Buffer.alloc(0)));
        } catch {
            /* ignore */
        }
    };

    socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (; ;) {
            if (buf.length < 2) return;
            const fin = (buf[0] & 0x80) !== 0;
            const op = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2);
                off = 4;
            } else if (len === 127) {
                if (buf.length < 10) return;
                len = Number(buf.readBigUInt64BE(2));
                off = 10;
            }
            const maskOff = off;
            if (masked) off += 4;
            if (buf.length < off + len) return;
            let payload = buf.subarray(off, off + len);
            if (masked) {
                const mask = buf.subarray(maskOff, maskOff + 4);
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            buf = buf.subarray(off + len);
            if (op === 0x8) {
                conn.close();
                return;
            }
            if (op === 0x9) {
                socket.write(frame(0xa, payload));
                continue;
            }
            if (op === 0xa) continue;
            if (op === 0x1 || op === 0x2 || op === 0x0) {
                frags.push(payload);
                if (fin) {
                    const msg = Buffer.concat(frags).toString("utf8");
                    frags = [];
                    if (conn.onmessage) conn.onmessage(msg);
                }
            }
        }
    });
    const closed = () => {
        if (conn._closedFired) return;
        conn._closedFired = true;
        conn.open = false;
        if (conn.onclose) conn.onclose();
    };
    socket.on("close", closed);
    socket.on("end", closed);
    socket.on("error", closed);
    return conn;
}

// ---------------------------------------------------------------- server mode
function startServer() {
    syncExtensionIfNeeded();
    const cfg = loadConfig(true);
    if (flags["reset-ext"]) {
        cfg.extId = null;
        saveConfig(cfg);
    }
    const verbose = !!flags.verbose;
    const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
    const vlog = (...a) => verbose && log(...a);

    let ext = null; // { conn, version, id, lastSeen }
    const waiters = new Map(); // jobId -> { resolve, timer }
    const mine = new Map(); // tabId -> info (tab yang dibuka bridge)

    const extAlive = () => !!(ext && ext.conn.open);

    const okHost = (req) => {
        const h = String(req.headers.host || "").toLowerCase();
        return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
    };
    const tokenOk = (req) => {
        const got = Buffer.from(String(req.headers["x-bridge-token"] || ""));
        const want = Buffer.from(cfg.token);
        return got.length === want.length && crypto.timingSafeEqual(got, want);
    };
    const extOrigin = (origin) => {
        const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(String(origin || ""));
        return m ? m[1] : null;
    };

    function waitExt(ms) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                if (extAlive()) return resolve(true);
                if (Date.now() - t0 > ms) return resolve(false);
                setTimeout(tick, 150);
            };
            tick();
        });
    }

    function relay(c, args, f, timeout) {
        const id = crypto.randomUUID();
        const wait = Number(timeout || f.timeout || CMD_TIMEOUT);
        const job = { type: "job", id, cmd: c, params: { args, flags: f }, expiresAt: Date.now() + wait };
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                waiters.delete(id);
                resolve({ ok: false, error: `Timeout ${wait}ms nunggu extension (halaman berat / dialog alert terbuka?)` });
            }, wait + 1000);
            waiters.set(id, { resolve, timer });
            ext.conn.send(JSON.stringify(job));
        });
    }

    const send = (res, code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
        res.end(body);
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        vlog(`[req] ${req.method} ${url.pathname}`);

        if (!okHost(req)) return send(res, 403, { ok: false, error: "host ditolak" });
        // Request dari website (Origin http/https/null) selalu ditolak. Tidak ada CORS sama sekali.
        if (req.headers.origin && !extOrigin(req.headers.origin)) return send(res, 403, { ok: false, error: "origin ditolak" });

        if (url.pathname === "/health") {
            return send(res, 200, {
                ok: true,
                ext: extAlive(),
                extVersion: ext ? ext.version : null,
                server: VERSION,
                protocol: PROTOCOL,
                transport: "websocket",
                lastSeenAgoMs: ext ? Date.now() - ext.lastSeen : null,
                pending: waiters.size,
            });
        }

        if (url.pathname === "/cmd" && req.method === "POST") {
            if (!tokenOk(req)) return send(res, 401, { ok: false, error: "token salah / tidak ada" });
            let body = "";
            for await (const c of req) body += c;
            let data;
            try {
                data = JSON.parse(body || "{}");
            } catch {
                return send(res, 400, { ok: false, error: "JSON tidak valid" });
            }
            const { cmd: c, args = [], flags: f = {}, timeout } = data;
            if (!c) return send(res, 400, { ok: false, error: "cmd kosong" });
            const lc = String(c).toLowerCase();

            if (lc === "mine" || lc === "tabs-mine") return send(res, 200, { ok: true, result: [...mine.values()] });

            // Baru start -> extension mungkin masih dalam jeda reconnect: tunggu lebih lama.
            const waitMs = process.uptime() < 30 ? 15000 : 4000;
            if (!extAlive() && !(await waitExt(waitMs))) return send(res, 503, { ok: false, error: EXT_HINT, hint: EXT_DIR });

            // Default tab group + isolasi per sesi (--session <id> -> "<defaultGroup>-<id>") + guard.
            const baseGroup = cfg.defaultGroup || "Antigravity";
            const sess = cleanSession(f.session);
            const sessGroup = sess ? `${baseGroup}-${sess}` : baseGroup;
            const createsNewTab = lc === "open" || lc === "new" || (lc === "goto" && (f.new === true || f.new === "true"));
            if (createsNewTab && !f.group && !f["no-group"] && baseGroup) {
                f.group = sessGroup;
                if (!f.color) f.color = sess ? sessionColor(sess) : cfg.defaultColor;
            }
            if (lc === "tabs" && sess && !f.group && !f["all-sessions"]) f.group = sessGroup;
            if ((lc === "close-group" || lc === "closegroup") && !args[0] && !f.group && !f["all-sessions"]) args.push(sessGroup);
            f.__guard = cfg.guard !== false;
            f.__guardGroup = baseGroup;
            if (sess) f.__sessionGroup = sessGroup;

            if (lc === "close-mine" || lc === "close-mine-all") {
                const items = [...mine.values()];
                if (f["dry-run"]) return send(res, 200, { ok: true, result: { dryRun: true, wouldClose: items } });
                const closed = [];
                const failed = [];
                for (const t of items) {
                    const r = await relay("close", [t.id], { tabId: t.id, force: true }, timeout);
                    if (r.ok) {
                        mine.delete(String(t.id));
                        closed.push(t.id);
                    } else failed.push({ id: t.id, error: r.error });
                }
                return send(res, 200, { ok: true, result: { closed, count: closed.length, failed, remaining: [...mine.values()] } });
            }

            const out = await relay(c, args, f, timeout);
            if (out.ok) {
                const r = out.result;
                if (createsNewTab && r && r.tabId !== undefined) {
                    mine.set(String(r.tabId), { id: r.tabId, url: r.url || "", title: r.title || "", groupId: r.groupId ?? null, at: Date.now() });
                }
                if (lc === "close" && r && r.closed !== undefined) mine.delete(String(r.closed));
                if ((lc === "close-group" || lc === "closegroup") && r && Array.isArray(r.closed)) r.closed.forEach((id) => mine.delete(String(id)));
            }
            return send(res, out.ok ? 200 : 500, out);
        }

        if (url.pathname === "/") return send(res, 200, { name: "brave-bridge", version: VERSION, ext: extAlive() });
        return send(res, 404, { ok: false, error: "not found" });
    });

    server.on("upgrade", (req, socket) => {
        const reject = (code, msg) => {
            socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
            socket.destroy();
        };
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (url.pathname !== "/ws" || !okHost(req)) return reject(404, "Not Found");
        const id = extOrigin(req.headers.origin);
        if (!id) return reject(403, "Forbidden");
        if (cfg.extId && cfg.extId !== id) {
            log(`[ws] DITOLAK: extension ${id} bukan yang di-pin (${cfg.extId}). Kalau memang ganti extension: serve --reset-ext`);
            return reject(403, "Forbidden");
        }
        if (!cfg.extId) {
            cfg.extId = id;
            saveConfig(cfg);
            log(`[ws] extension di-pin: ${id}`);
        }
        const conn = wsAccept(req, socket);
        if (ext && ext.conn.open) ext.conn.close();
        const me = { conn, version: null, id, lastSeen: Date.now() };
        ext = me;
        log(`[ws] extension konek (${id})`);
        conn.onmessage = (raw) => {
            me.lastSeen = Date.now();
            let m;
            try {
                m = JSON.parse(raw);
            } catch {
                return;
            }
            if (m.type === "hello") {
                me.version = m.version;
                log(`[ws] extension v${m.version}`);
                if (m.version !== VERSION) log(`[ws] PERINGATAN: versi extension (${m.version}) != server (${VERSION}). Reload extension.`);
            } else if (m.type === "result") {
                const w = waiters.get(m.id);
                if (w) {
                    waiters.delete(m.id);
                    clearTimeout(w.timer);
                    w.resolve(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error || "extension error" });
                }
            }
        };
        conn.onclose = () => {
            if (ext === me) ext = null;
            log("[ws] extension putus");
        };
    });

    // Ping server -> extension; tutup koneksi zombie.
    setInterval(() => {
        if (!ext) return;
        if (Date.now() - ext.lastSeen > 70000) {
            log("[ws] extension tidak merespon, tutup koneksi");
            ext.conn.close();
            ext = null;
            return;
        }
        ext.conn.send('{"type":"ping"}');
    }, 20000);

    server.listen(PORT, HOST, () => {
        log(`brave-bridge v${VERSION} listening on http://${HOST}:${PORT} (ws: /ws)`);
        log(`config: ${CONFIG_PATH}${cfg.extId ? ` | extension di-pin: ${cfg.extId}` : " | extension belum di-pin (pertama konek akan di-pin)"}`);
        log(`default group: "${cfg.defaultGroup}" (${cfg.defaultColor}) | guard: ${cfg.guard ? "ON" : "OFF"}`);
    });
    server.on("error", (e) => {
        if (e.code === "EADDRINUSE") console.error(`Port ${PORT} sudah dipakai. Server mungkin sudah jalan (cek: curl.exe -s http://127.0.0.1:${PORT}/health).`);
        else console.error(String(e.message || e));
        process.exit(1);
    });
}

// ---------------------------------------------------------------- CLI mode
function pretty(c, result) {
    if (flags.json) return JSON.stringify(result, null, 2);
    if (c === "mine" || c === "tabs-mine") {
        if (!Array.isArray(result) || !result.length) return "(tidak ada tab buatan bridge)";
        return result.map((t) => `[${t.id}] ${t.title || "(no title)"}\n      ${t.url || ""}`).join("\n");
    }
    if (c === "close-mine" || c === "close-mine-all") {
        if (result && result.dryRun) return `DRY-RUN: akan menutup ${result.wouldClose.length} tab:\n` + result.wouldClose.map((t) => `[${t.id}] ${t.url}`).join("\n");
        return `Ditutup: ${result.count} tab` + (result.failed.length ? `\nGagal: ${JSON.stringify(result.failed)}` : "");
    }
    if (c === "tabs" && Array.isArray(result)) {
        if (!result.length) return "(tidak ada tab)";
        return result
            .sort((a, b) => Number(b.active) - Number(a.active))
            .map((t) => `${t.active ? "*" : " "} [${t.id}]${t.group ? ` <${t.group}>` : ""} ${t.title || "(no title)"}\n      ${t.url || ""}`)
            .join("\n");
    }
    if (c === "close-group" || c === "closegroup") {
        if (result && result.note) return `${result.note} (ditutup: 0)`;
        return `Group "${result.group}": ditutup ${result.count} tab` + (result.closed.length ? ` [${result.closed.join(", ")}]` : "");
    }
    if (c === "snapshot" && result && Array.isArray(result.lines)) {
        return `${result.title}\n${result.url}\n${result.count} elemen interaktif\n\n${result.lines.join("\n")}`;
    }
    if (c === "links" && Array.isArray(result)) return result.map((l) => `${l.text || "(no text)"}\n    ${l.href}`).join("\n");
    if (c === "console" && Array.isArray(result)) {
        if (!result.length) return "(console kosong)";
        return result.map((e) => `[${new Date(e.t).toLocaleTimeString()}] ${String(e.level).toUpperCase().padEnd(9)} ${e.text}${e.src ? `  (${e.src})` : ""}`).join("\n");
    }
    if (c === "net" && Array.isArray(result)) {
        if (!result.length) return "(tidak ada request)";
        return result
            .map((r) => `${String(r.status ?? "...").padEnd(4)} ${r.method.padEnd(6)} ${(r.type || "").padEnd(10)} ${r.url.slice(0, 140)}${r.failed ? `  !! ${r.failed}` : ""}  #${r.id}`)
            .join("\n");
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
    const file = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : path.join(ARTIFACT_DIR, `shot-${ts()}.${ext}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(m[2], "base64"));
    return file;
}

async function savePdf(result) {
    if (!result || !result.pdfBase64) return null;
    const file = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : path.join(ARTIFACT_DIR, `page-${ts()}.pdf`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(result.pdfBase64, "base64"));
    return file;
}

async function readStdin() {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s;
}

function autostartSpec() {
    const scriptPath = fileURLToPath(import.meta.url);
    const home = os.homedir();
    if (process.platform === "win32") {
        const file = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "brave-bridge.vbs");
        const q = (s) => s.replace(/"/g, '""');
        const line = `cmd /c ""${q(process.execPath)}" "${q(scriptPath)}" serve >> "${q(LOG_PATH)}" 2>&1"`;
        const content = `' brave-bridge autostart (dibuat oleh brave-bridge.mjs install-autostart)\r\nCreateObject("WScript.Shell").Run "${q(line)}", 0, False\r\n`;
        return { kind: "windows-startup", file, content };
    }
    if (process.platform === "darwin") {
        const label = "id.anievo.brave-bridge";
        const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(scriptPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
</dict>
</plist>
`;
        return { kind: "launchd", file, content };
    }
    const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user");
    const file = path.join(unitDir, "brave-bridge.service");
    const content = `[Unit]
Description=AniEvo Brave Bridge local server
After=default.target

[Service]
Type=simple
ExecStart="${process.execPath}" "${scriptPath}" serve
Restart=on-failure
RestartSec=2
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`;
    return { kind: "systemd-user", file, content };
}

function installAutostart() {
    const spec = autostartSpec();
    mkdirSync(path.dirname(spec.file), { recursive: true });
    writeFileSync(spec.file, spec.content);
    if (spec.kind === "launchd") {
        try {
            execFileSync("launchctl", ["unload", spec.file], { stdio: "ignore" });
        } catch { /* ignore */ }
        try {
            execFileSync("launchctl", ["load", spec.file], { stdio: "ignore" });
        } catch { /* ignore */ }
    } else if (spec.kind === "systemd-user") {
        try {
            execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
            execFileSync("systemctl", ["--user", "enable", "--now", "brave-bridge.service"], { stdio: "ignore" });
        } catch {
            console.log("Catatan: systemctl --user belum aktif di sesi ini; unit sudah ditulis dan akan jalan saat sesi desktop aktif.");
        }
    }
    console.log(`Autostart (${spec.kind}) terpasang: ${spec.file}`);
    console.log(`Server jalan otomatis tiap login. Log: ${LOG_PATH}`);
}

function uninstallAutostart() {
    const spec = autostartSpec();
    if (spec.kind === "launchd" && existsSync(spec.file)) {
        try {
            execFileSync("launchctl", ["unload", spec.file], { stdio: "ignore" });
        } catch { /* ignore */ }
    } else if (spec.kind === "systemd-user" && existsSync(spec.file)) {
        try {
            execFileSync("systemctl", ["--user", "disable", "--now", "brave-bridge.service"], { stdio: "ignore" });
            execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        } catch { /* ignore */ }
    }
    if (existsSync(spec.file)) {
        unlinkSync(spec.file);
        console.log(`Autostart dihapus: ${spec.file}`);
    } else console.log("Autostart tidak terpasang.");
}

function printHelp() {
    console.log(`brave-bridge v${VERSION} — kontrol Brave yang sedang jalan (tanpa close/relaunch).

Server:
  serve [--verbose] [--reset-ext]             # jalankan bridge (biarkan hidup)
  extension-path                              # tampilkan (dan ekstrak bila via npm/npx) folder brave-extension
  install-autostart | uninstall-autostart     # jalan otomatis tiap login (Windows / macOS / Linux)

Info:
  status | tabs [--group "Nama"] | active | frames | url | title
  window [--state normal|maximized|minimized|fullscreen] [--width W] [--height H]

Tab (default: tab baru dibuka di BACKGROUND -> fokus user tidak pindah; --foreground untuk langsung aktif.
     Tab baru masuk group "Antigravity" (atau "Antigravity-<id>" dengan --session <id>); --no-group untuk skip):
  new [url] | open <url> | goto <url> --new | goto <url> --tabId N
  close [tabId] | activate <tabId> | reload [--hard] | back | forward
  close-group ["Nama"] [--all-sessions]       # tanpa nama = group sesi aktif; --all-sessions = semua sesi
  mine | close-mine [--dry-run]

Baca halaman:
  snapshot [--viewport] [--max N]             # elemen interaktif + ref @N  (pakai: click @3)
  text [sel] [--max N] | html [sel] [--max N] # default dipotong 20000 char, --max 0 = semua
  links | forms | count <sel> | attr <sel> <name>
  eval "<js>" | eval --file x.js | eval -     # async/await didukung; CSP ketat -> otomatis via CDP
       [--isolated] [--cdp] [--no-cdp]

Interaksi (selector: css | @N | text=Label | host >>> inner; tembus shadow DOM):
  click <sel> [--text "Label"] [--index N] [--double] [--button right] [--cdp]
  dblclick <sel> [--cdp] | rightclick <sel> [--cdp] | drag <asal> <tujuan> [--cdp]
  hover <sel> [--cdp] | focus <sel> [--clear]
  fill <sel> <value> [--append] [--cdp]       # React/contentEditable aman
  type <sel> <value> [--append] [--cdp]       # per karakter
  select <sel> <value|label> | check <sel> | uncheck <sel>
  key <Combo> [sel] [--cdp]                   # --cdp = keyboard trusted
  # Semua command (termasuk --cdp dan shot) jalan di tab BACKGROUND tanpa memindah fokus user.
  #   --activate = opsional: aktifkan tab sebentar lalu kembalikan (kalau situs butuh tab kelihatan).
  scroll [top|bottom|+500|-500|sel]
  upload <sel input[type=file]> <file...>     # via CDP
  dialog accept|dismiss|once-accept|once-dismiss|auto-accept|auto-dismiss|off|status [promptText]
  --frame N | --frame all                     # target iframe (lihat: frames)

Cookies & Storage (termasuk HttpOnly via CDP, dibatasi ke origin tab agent):
  cookies [list | set <k> <v> [--http-only] [--secure] [--sameSite Lax|Strict|None] | delete <k> | clear]
  storage [list | get <k> | set <k> <v> | remove <k> | clear] [--session-storage]

Tunggu:
  wait <ms> | waitFor <sel> [--gone] | waitFor --text "..." [--gone] | waitUrl <substr|/regex/>

Screenshot, PDF & Responsive Emulation:
  shot [--jpeg] [--quality 80] [--selector sel] [--full] [--out file] [--activate]
  pdf [--landscape] [--no-bg] [--out file.pdf]
  emulate iphone|pixel|ipad|desktop|reset [--width W --height H] [--dpr N] [--mobile] [--color-scheme dark|light]

Console & network (CDP, Brave tampilkan bar "debugging" selama capture):
  capture start|stop|status [--tabId N]
  console [--level error|warning|log] [--last N] [--clear] [--all]   # --all = ikut log extension lain
  net [--filter str] [--failed] [--last N] [--clear] | net --body <requestId>

Guard: aksi yang mengubah tab di luar group "Antigravity" (atau sesi lain) ditolak kecuali --force.
Global: --tabId N  --session <id> (atau env BRAVE_BRIDGE_SESSION)  --timeout ms  --json`);
}

async function runCli() {
    if (cmd === "help" || flags.help) return printHelp();
    if (cmd === "extension-path" || cmd === "ext-path") {
        console.log(syncExtensionIfNeeded());
        return;
    }
    if (cmd === "install-autostart") return installAutostart();
    if (cmd === "uninstall-autostart") return uninstallAutostart();
    if (!flags.session && process.env.BRAVE_BRIDGE_SESSION) flags.session = process.env.BRAVE_BRIDGE_SESSION;

    const cfg = loadConfig(false);
    if (!cfg.token) {
        console.error(`Token belum ada (${CONFIG_PATH}). Jalankan server dulu: node "${fileURLToPath(import.meta.url)}" serve`);
        process.exit(2);
    }

    const args = positional.slice();
    if (cmd === "eval") {
        if (flags.file && flags.file !== true) {
            args.splice(0, args.length, await readFile(path.resolve(String(flags.file)), "utf8"));
            delete flags.file;
        } else if (args.length === 1 && args[0] === "-") {
            args.splice(0, 1, await readStdin());
        }
    }
    if (cmd === "upload") {
        for (let i = 1; i < args.length; i++) {
            args[i] = path.resolve(args[i]);
            if (!existsSync(args[i])) {
                console.error(`File tidak ada: ${args[i]}`);
                process.exit(1);
            }
        }
    }

    let res;
    try {
        res = await fetch(`http://${HOST}:${PORT}/cmd`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bridge-token": cfg.token },
            body: JSON.stringify({ cmd, args, flags, timeout: Number(flags.timeout || CMD_TIMEOUT) }),
        });
    } catch {
        console.error(`Tidak bisa konek ke bridge (http://${HOST}:${PORT}). Server belum jalan?`);
        console.error(`Jalankan: node "${fileURLToPath(import.meta.url)}" serve`);
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
        console.log(`mode: ${json.result.note}`);
        return;
    }
    if (cmd === "pdf") {
        const file = await savePdf(json.result);
        console.log(`pdf: ${file || "(gagal simpan)"}`);
        console.log(`tab: ${json.result.title} — ${json.result.url}`);
        return;
    }
    console.log(pretty(cmd, json.result));
}

if (cmd === "serve" || cmd === "server") startServer();
else runCli();
