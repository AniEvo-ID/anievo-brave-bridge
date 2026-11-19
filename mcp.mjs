#!/usr/bin/env node
/**
 * mcp.mjs — MCP server (stdio) untuk AniEvo Brave Bridge. Zero dependency, Node >= 18.
 *
 * Expose bridge sebagai tool MCP (browser_open, browser_snapshot, browser_click, ...), jadi AI agent
 * tidak perlu lewat shell. Di belakang layar memanggil server bridge (http://127.0.0.1:8787/cmd)
 * dengan token dari config.json. Kalau server bridge belum jalan, otomatis di-start (tersembunyi).
 *
 * Config MCP client:
 *   { "mcpServers": { "brave-bridge": { "command": "node", "args": ["<path>/mcp.mjs"] } } }
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.2.0";
const PORT = Number(process.env.BRAVE_BRIDGE_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const BRIDGE = path.join(__dirname, "brave-bridge.mjs");
const ARTIFACT_DIR = process.env.BRAVE_CDP_ARTIFACTS || path.join(os.homedir(), ".brave-cdp", "artifacts");
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const log = (...a) => process.stderr.write(`[brave-bridge-mcp] ${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- bridge client
async function health(timeoutMs = 4000) {
    try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        return await r.json();
    } catch {
        return null;
    }
}

let starting = null;
async function ensureServer() {
    // Fetch pertama Node bisa lambat (inisialisasi undici) -> cek 2x sebelum menyimpulkan server mati.
    if ((await health()) || (await health())) return;
    if (!starting) {
        starting = (async () => {
            log("server bridge belum jalan, start otomatis...");
            const logFd = openSync(path.join(__dirname, "server.log"), "a");
            const child = spawn(process.execPath, [BRIDGE, "serve"], { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
            child.unref();
            for (let i = 0; i < 30; i++) {
                await sleep(200);
                if (await health(1000)) return;
            }
            throw new Error("Gagal start server bridge otomatis. Jalankan manual: node brave-bridge.mjs serve");
        })().finally(() => {
            starting = null;
        });
    }
    await starting;
}

function token() {
    if (!existsSync(CONFIG_PATH)) return null;
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, "utf8")).token || null;
    } catch {
        return null;
    }
}

async function bridge(cmd, args = [], flags = {}) {
    await ensureServer();
    const tok = token();
    if (!tok) throw new Error(`Token tidak ada di ${CONFIG_PATH}.`);
    const timeout = Number(flags.timeout || 45000);
    const res = await fetch(`${BASE}/cmd`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-token": tok },
        body: JSON.stringify({ cmd, args, flags, timeout }),
        signal: AbortSignal.timeout(timeout + 5000),
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(json.error || "bridge error");
    return json.result;
}

// ---------------------------------------------------------------- tool definitions
const S = {
    tabId: { type: "integer", description: "Target tab id (from browser_open / browser_tabs). Omit = active tab." },
    selector: {
        type: "string",
        description: 'Element selector: CSS (pierces open shadow DOM), "@N" ref from browser_snapshot, "text=Label", or "host >>> inner".',
    },
    frame: { type: "string", description: 'Iframe target: frame id (see browser_frames) or "all" to search every frame.' },
    trusted: { type: "boolean", description: "Use CDP for trusted input (event.isTrusted=true). Works in background tabs; shows Brave's debugging bar briefly." },
};
const obj = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });

const common = (a) => {
    const f = {};
    if (a.tabId !== undefined) f.tabId = a.tabId;
    if (a.frame !== undefined) f.frame = String(a.frame);
    if (a.timeoutMs !== undefined) f.timeout = a.timeoutMs;
    return f;
};

const TOOLS = [
    {
        name: "browser_status",
        description: "Check bridge/extension connection and versions.",
        readOnly: true,
        inputSchema: obj({}),
        run: async () => {
            const ext = await bridge("status");
            return { health: await health(), ext };
        },
    },
    {
        name: "browser_tabs",
        description: 'List open tabs (id, title, url, group). Filter by tab group name with "group".',
        readOnly: true,
        inputSchema: obj({ group: { type: "string" } }),
        run: (a) => bridge("tabs", [], a.group ? { group: a.group } : {}),
    },
    {
        name: "browser_open",
        description:
            'Open URL in a NEW tab inside the agent tab group (default "Antigravity"), in the BACKGROUND so the user keeps their current tab. Returns tabId — pass it to every other tool.',
        inputSchema: obj({ url: { type: "string" }, foreground: { type: "boolean", description: "Activate the tab (only if the user asks)." } }, ["url"]),
        run: (a) => bridge("new", [a.url], a.foreground ? { foreground: true } : {}),
    },
    {
        name: "browser_navigate",
        description: "Navigate an existing agent tab to a URL, or go back / forward / reload.",
        inputSchema: obj(
            {
                tabId: S.tabId,
                url: { type: "string", description: "URL to load (omit when using action)." },
                action: { type: "string", enum: ["back", "forward", "reload"] },
            },
            ["tabId"]
        ),
        run: (a) => (a.action ? bridge(a.action, [], common(a)) : bridge("goto", [a.url], common(a))),
    },
    {
        name: "browser_snapshot",
        description:
            "List interactive elements on the page with refs (@1, @2, ...) plus headings. Start here, then use the refs as selector in click/fill/etc. Refs reset on every snapshot.",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, frame: S.frame, viewportOnly: { type: "boolean" }, max: { type: "integer", description: "Max elements (default 250)." } }),
        run: async (a) => {
            const f = common(a);
            if (a.viewportOnly) f.viewport = true;
            if (a.max) f.max = a.max;
            const r = await bridge("snapshot", [], f);
            return `${r.title}\n${r.url}\n${r.count} interactive elements\n\n${r.lines.join("\n")}`;
        },
    },
    {
        name: "browser_click",
        description: "Click an element (full pointer event sequence; works with React/Radix menus). Use selector or text.",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, text: { type: "string", description: "Visible text to match." }, index: { type: "integer" }, frame: S.frame, trusted: S.trusted }),
        run: (a) => {
            const f = common(a);
            if (a.text) f.text = a.text;
            if (a.index) f.index = a.index;
            if (a.trusted) f.cdp = true;
            return bridge("click", a.selector ? [a.selector] : [], f);
        },
    },
    {
        name: "browser_fill",
        description: "Set the value of an input/textarea/contentEditable at once (React-safe). Use browser_type for per-character typing.",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, value: { type: "string" }, append: { type: "boolean" }, frame: S.frame, trusted: S.trusted }, ["selector", "value"]),
        run: (a) => bridge("fill", [a.selector, a.value], { ...common(a), ...(a.append ? { append: true } : {}), ...(a.trusted ? { cdp: true } : {}) }),
    },
    {
        name: "browser_type",
        description: "Type text character by character (keydown/input/keyup) — good for autocomplete/search boxes.",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, value: { type: "string" }, append: { type: "boolean" }, frame: S.frame, trusted: S.trusted }, ["selector", "value"]),
        run: (a) => bridge("type", [a.selector, a.value], { ...common(a), ...(a.append ? { append: true } : {}), ...(a.trusted ? { cdp: true } : {}) }),
    },
    {
        name: "browser_select",
        description: "Choose an option in a native <select> by value or visible label.",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, value: { type: "string" }, frame: S.frame }, ["selector", "value"]),
        run: (a) => bridge("select", [a.selector, a.value], common(a)),
    },
    {
        name: "browser_check",
        description: "Check or uncheck a checkbox / switch / radio.",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, checked: { type: "boolean" }, frame: S.frame }, ["selector", "checked"]),
        run: (a) => bridge(a.checked ? "check" : "uncheck", [a.selector], common(a)),
    },
    {
        name: "browser_press_key",
        description: 'Press a key or combo, e.g. "Enter", "Escape", "Control+a", "ArrowDown". Enter in a form input submits the form.',
        inputSchema: obj({ tabId: S.tabId, key: { type: "string" }, selector: { ...S.selector, description: "Element to focus first (optional)." }, frame: S.frame, trusted: S.trusted }, ["key"]),
        run: (a) => bridge("key", a.selector ? [a.key, a.selector] : [a.key], { ...common(a), ...(a.trusted ? { cdp: true } : {}) }),
    },
    {
        name: "browser_hover",
        description: "Hover over an element (opens hover menus/tooltips).",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, frame: S.frame, trusted: S.trusted }, ["selector"]),
        run: (a) => bridge("hover", [a.selector], { ...common(a), ...(a.trusted ? { cdp: true } : {}) }),
    },
    {
        name: "browser_scroll",
        description: 'Scroll the page (or its main scroll container): "top", "bottom", "+500", "-500", or a selector to scroll into view.',
        inputSchema: obj({ tabId: S.tabId, to: { type: "string" } }, ["to"]),
        run: (a) => bridge("scroll", [a.to], common(a)),
    },
    {
        name: "browser_text",
        description: "Get visible text of the page or an element (truncated to max chars, default 20000; 0 = no limit).",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, max: { type: "integer" }, frame: S.frame }),
        run: (a) => bridge("text", a.selector ? [a.selector] : [], { ...common(a), ...(a.max !== undefined ? { max: a.max } : {}) }),
    },
    {
        name: "browser_html",
        description: "Get outerHTML of the page or an element (truncated to max chars, default 20000).",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, max: { type: "integer" }, frame: S.frame }),
        run: (a) => bridge("html", a.selector ? [a.selector] : [], { ...common(a), ...(a.max !== undefined ? { max: a.max } : {}) }),
    },
    {
        name: "browser_links",
        description: "List visible links (text + href).",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, frame: S.frame }),
        run: (a) => bridge("links", [], common(a)),
    },
    {
        name: "browser_forms",
        description: "List form fields (name, type, label, current value; passwords masked).",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, frame: S.frame }),
        run: (a) => bridge("forms", [], common(a)),
    },
    {
        name: "browser_frames",
        description: "List iframes in a tab (frameId, url).",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId }),
        run: (a) => bridge("frames", [], common(a)),
    },
    {
        name: "browser_eval",
        description:
            "Run JavaScript in the page (MAIN world, sees page globals). Supports await; for multi-statement code use `return`. Strict-CSP pages fall back to CDP automatically.",
        inputSchema: obj({ tabId: S.tabId, code: { type: "string" } }, ["code"]),
        run: (a) => bridge("eval", [a.code], common(a)),
    },
    {
        name: "browser_wait_for",
        description: "Wait until a selector or text appears (or disappears with gone=true), or until the URL matches urlPattern (substring or /regex/).",
        readOnly: true,
        inputSchema: obj({
            tabId: S.tabId,
            selector: S.selector,
            text: { type: "string" },
            urlPattern: { type: "string" },
            gone: { type: "boolean" },
            timeoutMs: { type: "integer", description: "Default 15000." },
            frame: S.frame,
        }),
        run: (a) => {
            const f = common(a);
            if (a.urlPattern) return bridge("waitUrl", [a.urlPattern], f);
            if (a.text) f.text = a.text;
            if (a.gone) f.gone = true;
            return bridge("waitFor", a.selector ? [a.selector] : [], f);
        },
    },
    {
        name: "browser_screenshot",
        description: "Screenshot a tab (viewport, a single element, or full page) without stealing the user's focus. Returns the image and saves it to disk.",
        readOnly: true,
        inputSchema: obj({
            tabId: S.tabId,
            selector: { ...S.selector, description: "Capture only this element." },
            fullPage: { type: "boolean" },
            format: { type: "string", enum: ["png", "jpeg"], description: "Default png (jpeg for fullPage)." },
        }),
        run: async (a) => {
            const f = common(a);
            if (a.selector) f.selector = a.selector;
            if (a.fullPage) f.full = true;
            const jpeg = a.format ? a.format === "jpeg" : !!a.fullPage;
            if (jpeg) {
                f.jpeg = true;
                f.quality = 70;
            }
            const r = await bridge("shot", [], f);
            const m = /^data:(image\/(png|jpeg));base64,(.*)$/s.exec(r.dataUrl || "");
            if (!m) throw new Error("Screenshot kosong.");
            await mkdir(ARTIFACT_DIR, { recursive: true });
            const file = path.join(ARTIFACT_DIR, `mcp-shot-${Date.now()}.${m[2] === "jpeg" ? "jpg" : "png"}`);
            await writeFile(file, Buffer.from(m[3], "base64"));
            return {
                content: [
                    { type: "image", data: m[3], mimeType: m[1] },
                    { type: "text", text: `${r.title} — ${r.url}\nmode: ${r.note}\nsaved: ${file}` },
                ],
            };
        },
    },
    {
        name: "browser_capture",
        description: "Start/stop console + network capture on a tab via CDP (Brave shows a debugging bar until stopped).",
        inputSchema: obj({ tabId: S.tabId, action: { type: "string", enum: ["start", "stop", "status"] } }, ["action"]),
        run: (a) => bridge("capture", [a.action], common(a)),
    },
    {
        name: "browser_console",
        description: "Read captured console messages (needs browser_capture start). level: error|warning|log|info.",
        readOnly: true,
        inputSchema: obj({ tabId: S.tabId, level: { type: "string" }, last: { type: "integer" }, clear: { type: "boolean" } }),
        run: (a) => bridge("console", [], { ...common(a), ...(a.level ? { level: a.level } : {}), ...(a.last ? { last: a.last } : {}), ...(a.clear ? { clear: true } : {}) }),
    },
    {
        name: "browser_network",
        description: "Read captured network requests (needs browser_capture start). Use responseBodyOf=<requestId> to fetch a response body.",
        readOnly: true,
        inputSchema: obj({
            tabId: S.tabId,
            filter: { type: "string", description: "URL substring." },
            failedOnly: { type: "boolean" },
            last: { type: "integer" },
            responseBodyOf: { type: "string" },
            clear: { type: "boolean" },
        }),
        run: (a) => {
            const f = common(a);
            if (a.responseBodyOf) f.body = a.responseBodyOf;
            if (a.filter) f.filter = a.filter;
            if (a.failedOnly) f.failed = true;
            if (a.last) f.last = a.last;
            if (a.clear) f.clear = true;
            return bridge("net", [], f);
        },
    },
    {
        name: "browser_upload",
        description: "Set files on an <input type=file> (absolute local paths).",
        inputSchema: obj({ tabId: S.tabId, selector: S.selector, files: { type: "array", items: { type: "string" } } }, ["selector", "files"]),
        run: (a) => {
            for (const p of a.files) if (!existsSync(p)) throw new Error(`File tidak ada: ${p}`);
            return bridge("upload", [a.selector, ...a.files.map((p) => path.resolve(p))], common(a));
        },
    },
    {
        name: "browser_close_tab",
        description: "Close one agent tab.",
        inputSchema: obj({ tabId: S.tabId }, ["tabId"]),
        run: (a) => bridge("close", [a.tabId], common(a)),
    },
    {
        name: "browser_close_group",
        description: 'Close ALL tabs in the agent tab group (default "Antigravity"). Call this when the task is done. User tabs are never touched.',
        inputSchema: obj({ group: { type: "string" } }),
        run: (a) => bridge("close-group", a.group ? [a.group] : [], {}),
    },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- JSON-RPC over stdio
function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function onMessage(msg) {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
        switch (method) {
            case "initialize": {
                const want = params.protocolVersion;
                return reply(id, {
                    protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "brave-bridge", version: VERSION },
                    instructions:
                        "Controls the user's running Brave browser. Workflow: browser_open (background tab in the agent group) -> browser_snapshot -> act with @refs -> browser_close_group when done. Never act on user tabs outside the agent group (the bridge guard rejects it).",
                });
            }
            case "notifications/initialized":
            case "notifications/cancelled":
                return;
            case "ping":
                return reply(id, {});
            case "tools/list":
                return reply(id, {
                    tools: TOOLS.map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        annotations: { readOnlyHint: !!t.readOnly, openWorldHint: true },
                    })),
                });
            case "tools/call": {
                const tool = TOOL_MAP.get(params.name);
                if (!tool) return reply(id, { isError: true, content: [{ type: "text", text: `Tool tidak dikenal: ${params.name}` }] });
                try {
                    const out = await tool.run(params.arguments || {});
                    if (out && Array.isArray(out.content)) return reply(id, out);
                    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
                    return reply(id, { content: [{ type: "text", text: text ?? "null" }] });
                } catch (e) {
                    return reply(id, { isError: true, content: [{ type: "text", text: `GAGAL: ${e.message || e}` }] });
                }
            }
            default:
                if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
        }
    } catch (e) {
        if (isRequest) fail(id, -32603, String(e.message || e));
    }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            fail(null, -32700, "Parse error");
            continue;
        }
        if (Array.isArray(msg)) msg.forEach(onMessage);
        else onMessage(msg);
    }
});
process.stdin.on("end", () => process.exit(0));
log(`v${VERSION} siap (stdio), bridge: ${BASE}`);
