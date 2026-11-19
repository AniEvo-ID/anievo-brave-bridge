import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "brave-bridge.mjs");
const MCP = path.join(ROOT, "mcp.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
        s.on("error", reject);
    });
}

function findBrowser() {
    if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    const candidates =
        process.platform === "win32"
            ? [
                  path.join(process.env.ProgramFiles || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                  path.join(process.env["ProgramFiles(x86)"] || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                  path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                  path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
                  path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
              ]
            : process.platform === "darwin"
              ? [
                    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    "/Applications/Chromium.app/Contents/MacOS/Chromium",
                ]
              : ["/usr/bin/brave-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
    return candidates.find((p) => p && existsSync(p)) || null;
}

function createFixtureServer(bridgePort) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>BB Fixture</title>
<style>body{font-family:sans-serif;padding:16px} .tall{height:2000px} #menu{display:none;padding:4px;border:1px solid #888}</style>
</head><body>
<h1 id="title">Brave Bridge Fixture</h1>
<input id="rname" placeholder="Nama" value="">
<p>Echo: <b id="echo"></b></p>
<div id="editor" contenteditable="true" style="border:1px solid #999;min-height:28px"></div>
<p>Editor: <b id="edEcho"></b></p>
<button id="menuBtn">Menu</button>
<div id="menu"><div role="menuitem" id="menuItem">Hapus item</div></div>
<p>Menu: <b id="menuResult"></b></p>
<x-card></x-card><p>Shadow: <b id="shadowResult"></b></p>
<iframe id="fr" srcdoc="<button id='inner' onclick=&quot;this.textContent='inner clicked'&quot;>inner</button>" style="height:50px"></iframe>
<select id="fruit"><option value="a">Apel</option><option value="m">Mangga</option></select>
<label><input type="checkbox" id="agree"> Setuju</label>
<form id="f"><input id="q" name="q" placeholder="Cari"></form><p>Submitted: <b id="submitted"></b></p>
<input type="file" id="file"><p>File: <b id="fileName"></b></p>
<button id="trusted">Trusted?</button><p>isTrusted: <b id="trustedResult"></b></p>
<p>Last key: <b id="lastKey"></b></p>
<button id="logBtn">Log</button>
<p id="attackResult">pending</p>
<div class="tall">spacer</div>
<script>
customElements.define("x-card", class extends HTMLElement {
  connectedCallback(){
    const s = this.attachShadow({ mode: "open" });
    s.innerHTML = '<button id="sbtn">Shadow OK</button>';
    s.getElementById("sbtn").onclick = () => document.getElementById("shadowResult").textContent = "shadow clicked";
  }
});
// Controlled-like input: updates echo ONLY when native value setter + input event fire together.
rname.addEventListener("input", (ev) => { echo.textContent = ev.target.value; });
editor.addEventListener("input", () => { edEcho.textContent = editor.innerText.trim(); });
menuBtn.addEventListener("pointerdown", () => { menu.style.display = "block"; });
menuItem.addEventListener("pointerup", () => { menuResult.textContent = "hapus dipilih"; });
f.addEventListener("submit", (ev) => { ev.preventDefault(); submitted.textContent = q.value; });
file.addEventListener("change", () => { fileName.textContent = file.files[0] ? file.files[0].name : ""; });
trusted.addEventListener("click", (ev) => { trustedResult.textContent = String(ev.isTrusted); });
document.addEventListener("keydown", (ev) => { lastKey.textContent = ev.key + " trusted=" + ev.isTrusted; });
logBtn.onclick = () => { console.log("hello fixture"); fetch("/api/ping"); fetch("/api/missing"); };
window.getData = async () => { await new Promise((r) => setTimeout(r, 80)); return { answer: 42 }; };
(async () => {
  const out = [];
  try {
    const r = await fetch("http://127.0.0.1:${bridgePort}/cmd", { method: "POST", headers: { "content-type": "application/json" }, body: '{"cmd":"status"}' });
    out.push("json:" + r.status);
  } catch { out.push("json:BLOCKED"); }
  try {
    await new Promise((res) => {
      const w = new WebSocket("ws://127.0.0.1:${bridgePort}/ws");
      w.onopen = () => { out.push("ws:OPEN"); w.close(); res(); };
      w.onerror = () => { out.push("ws:BLOCKED"); res(); };
    });
  } catch { out.push("ws:BLOCKED"); }
  attackResult.textContent = out.join("|");
})();
</script></body></html>`;

    const csp = `<!doctype html><html><head><meta charset="utf-8"><title>BB CSP</title></head><body>
<h1>CSP strict</h1><script nonce="abc">window.secret = "csp-ok";</script></body></html>`;

    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            if (req.url === "/api/ping") {
                res.writeHead(200, { "content-type": "application/json" });
                return res.end('{"pong":true}');
            }
            if (req.url === "/csp") {
                res.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'nonce-abc'" });
                return res.end(csp);
            }
            if (req.url === "/") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(html);
            }
            res.writeHead(404);
            res.end("nope");
        });
        srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
}

test("AniEvo Brave Bridge — security, CLI + extension E2E, session groups, and MCP", { timeout: 120000 }, async (t) => {
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bb-ci-")));
    const bridgePort = await freePort();
    const configPath = path.join(tmp, "config.json");
    const artifactDir = path.join(tmp, "artifacts");
    const extDir = path.join(tmp, "ext");
    const profileDir = path.join(tmp, "profile");
    const evalFile = path.join(tmp, "sample-eval.js");
    writeFileSync(evalFile, 'JSON.stringify({ pCount: document.querySelectorAll("p").length })');

    cpSync(path.join(ROOT, "brave-extension"), extDir, { recursive: true });
    writeFileSync(
        path.join(extDir, "background.js"),
        readFileSync(path.join(extDir, "background.js"), "utf8").replaceAll("ws://127.0.0.1:8787/ws", `ws://127.0.0.1:${bridgePort}/ws`)
    );

    const env = {
        ...process.env,
        BRAVE_BRIDGE_PORT: String(bridgePort),
        BRAVE_BRIDGE_CONFIG: configPath,
        BRAVE_CDP_ARTIFACTS: artifactDir,
    };
    delete env.BRAVE_BRIDGE_SESSION;

    const fixture = await createFixtureServer(bridgePort);
    const serverLogs = [];
    const serverProc = spawn(process.execPath, [BRIDGE, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    serverProc.stdout.on("data", (d) => serverLogs.length < 40 && serverLogs.push(d.toString()));
    serverProc.stderr.on("data", (d) => serverLogs.length < 40 && serverLogs.push(d.toString()));
    let browserProc = null;
    const browserLogs = [];

    t.after(async () => {
        fixture.srv.close();
        if (browserProc && !browserProc.killed) browserProc.kill("SIGKILL");
        if (!serverProc.killed) serverProc.kill("SIGKILL");
        await sleep(300);
        try {
            rmSync(tmp, { recursive: true, force: true });
        } catch {
            /* Windows file lock tolerance */
        }
    });

    // Wait for bridge HTTP server to listen & generate config.json.
    for (let i = 0; i < 40; i++) {
        if (existsSync(configPath)) {
            try {
                const r = await fetch(`http://127.0.0.1:${bridgePort}/health`);
                if (r.ok) break;
            } catch {
                /* retry */
            }
        }
        await sleep(100);
    }
    assert.ok(existsSync(configPath), "server should generate config.json");
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.match(cfg.token, /^[0-9a-f]{48}$/);

    // --------------------------------------------------------- 1. Security checks
    await t.test("server security boundaries", async () => {
        const base = `http://127.0.0.1:${bridgePort}`;
        const noTok = await fetch(`${base}/cmd`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"cmd":"status"}',
        });
        assert.equal(noTok.status, 401);

        const badTok = await fetch(`${base}/cmd`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bridge-token": "0".repeat(48) },
            body: '{"cmd":"status"}',
        });
        assert.equal(badTok.status, 401);

        const webOrigin = await fetch(`${base}/cmd`, {
            method: "POST",
            headers: { Origin: "https://evil.example", "content-type": "text/plain", "x-bridge-token": cfg.token },
            body: '{"cmd":"status"}',
        });
        assert.equal(webOrigin.status, 403);
        assert.equal(webOrigin.headers.get("access-control-allow-origin"), null);

        const preflight = await fetch(`${base}/cmd`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
        assert.equal(preflight.status, 403);

        // Anti DNS-rebinding Host header check via raw HTTP request.
        const rebindCode = await new Promise((resolve, reject) => {
            const req = http.request({ host: "127.0.0.1", port: bridgePort, path: "/health", headers: { Host: "evil.example:8787" } }, (res) => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(rebindCode, 403);

        // WebSocket upgrade from regular website Origin must be rejected.
        const wsCode = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port: bridgePort,
                    path: "/ws",
                    headers: {
                        Connection: "Upgrade",
                        Upgrade: "websocket",
                        Origin: "https://evil.example",
                        "Sec-WebSocket-Version": "13",
                        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                    },
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode);
                }
            );
            req.on("error", reject);
            req.end();
        });
        assert.equal(wsCode, 403);
    });

    // --------------------------------------------------------- 2. Browser + Extension E2E
    const browserBin = findBrowser();
    if (!browserBin) {
        t.diagnostic("No Chromium/Brave binary found; skipping browser E2E.");
        return;
    }

    const browserArgs = [
        `--user-data-dir=${profileDir}`,
        `--load-extension=${extDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-popup-blocking",
        "--window-size=1280,800",
    ];
    if (process.platform === "linux") browserArgs.push("--no-sandbox");
    // On Windows or when no X11/Wayland DISPLAY exists, run in modern headless mode (--headless=new supports MV3 extensions).
    if (process.env.BB_HEADED !== "1" && (process.platform === "win32" || !process.env.DISPLAY)) {
        browserArgs.push("--headless=new");
    }
    browserArgs.push("--enable-logging=stderr", `${fixture.url}/`);
    browserProc = spawn(browserBin, browserArgs, { stdio: ["ignore", "ignore", "pipe"] });
    browserProc.stderr.on("data", (d) => browserLogs.length < 40 && browserLogs.push(d.toString()));

    for (let i = 0; i < 100; i++) {
        const h = await fetch(`http://127.0.0.1:${bridgePort}/health`).then((r) => r.json());
        if (h.ext) break;
        await sleep(150);
    }
    const healthAfter = await fetch(`http://127.0.0.1:${bridgePort}/health`).then((r) => r.json());
    assert.equal(
        healthAfter.ext,
        true,
        `extension failed to connect using ${browserBin}\nSERVER:\n${serverLogs.join("")}\nBROWSER:\n${browserLogs.join("")}`
    );

    const cli = (args, extraEnv = {}) =>
        new Promise((resolve) => {
            execFile(process.execPath, [BRIDGE, ...args], { env: { ...env, ...extraEnv } }, (err, stdout, stderr) => {
                resolve({ code: err ? err.code || 1 : 0, out: stdout.trim(), err: stderr.trim() });
            });
        });

    let userTabId;
    await t.test("CLI + extension DOM, CDP, screenshot, and guard", async () => {
        const tabs0 = JSON.parse((await cli(["tabs", "--json"])).out);
        const userTab = tabs0.find((x) => !x.group) || tabs0[0];
        userTabId = userTab.id;

        const opened = JSON.parse((await cli(["new", `${fixture.url}/`, "--json"])).out);
        const tab = String(opened.tabId);
        assert.equal(opened.group, "Antigravity");

        const tabs1 = JSON.parse((await cli(["tabs", "--json"])).out);
        assert.equal(tabs1.find((x) => x.id === opened.tabId).active, false, "new agent tab must open in background");

        await cli(["waitFor", "#rname", "--tabId", tab]);
        // Wait briefly for inline attack simulation to settle.
        for (let i = 0; i < 20; i++) {
            const atk = (await cli(["text", "#attackResult", "--tabId", tab])).out;
            if (atk !== "pending") {
                assert.match(atk, /^json:(BLOCKED|403)\|ws:BLOCKED$/);
                break;
            }
            await sleep(100);
        }

        const snap = (await cli(["snapshot", "--tabId", tab])).out;
        assert.match(snap, /@\d+ button "Menu"/);

        await cli(["fill", "#rname", "Ari", "--tabId", tab]);
        assert.equal((await cli(["text", "#echo", "--tabId", tab])).out, "Ari");

        await cli(["fill", "#editor", "halo editor", "--tabId", tab]);
        assert.equal((await cli(["text", "#edEcho", "--tabId", tab])).out, "halo editor");

        await cli(["click", "#menuBtn", "--tabId", tab]);
        await cli(["click", "text=Hapus item", "--tabId", tab]);
        assert.equal((await cli(["text", "#menuResult", "--tabId", tab])).out, "hapus dipilih");

        await cli(["click", "#sbtn", "--tabId", tab]);
        assert.equal((await cli(["text", "#shadowResult", "--tabId", tab])).out, "shadow clicked");

        await cli(["click", "#inner", "--frame", "all", "--tabId", tab]);
        assert.equal((await cli(["text", "#inner", "--frame", "all", "--tabId", tab])).out, "inner clicked");

        const selRes = JSON.parse((await cli(["select", "#fruit", "Mangga", "--tabId", tab])).out);
        assert.equal(selRes.value, "m");

        const chkRes = JSON.parse((await cli(["check", "#agree", "--tabId", tab])).out);
        assert.equal(chkRes.checked, true);

        await cli(["fill", "#q", "cari ini", "--tabId", tab]);
        await cli(["key", "Enter", "#q", "--tabId", tab]);
        assert.equal((await cli(["text", "#submitted", "--tabId", tab])).out, "cari ini");

        const asyncExpr = JSON.parse((await cli(["eval", "await window.getData()", "--tabId", tab])).out);
        assert.equal(asyncExpr.answer, 42);

        const asyncBlock = JSON.parse((await cli(["eval", "const d = await window.getData(); return d.answer * 2", "--tabId", tab])).out);
        assert.equal(asyncBlock, 84);

        const fromFile = JSON.parse((await cli(["eval", "--file", evalFile, "--tabId", tab])).out);
        assert.ok(fromFile.pCount >= 5);

        await cli(["click", "#trusted", "--cdp", "--tabId", tab]);
        assert.equal((await cli(["text", "#trustedResult", "--tabId", tab])).out, "true");

        await cli(["key", "z", "#q", "--cdp", "--tabId", tab]);
        assert.equal((await cli(["text", "#lastKey", "--tabId", tab])).out, "z trusted=true");

        await cli(["upload", "#file", evalFile, "--tabId", tab]);
        assert.equal((await cli(["text", "#fileName", "--tabId", tab])).out, "sample-eval.js");

        await cli(["capture", "start", "--tabId", tab]);
        await cli(["click", "#logBtn", "--tabId", tab]);
        await sleep(300);
        assert.match((await cli(["console", "--tabId", tab])).out, /hello fixture/);
        assert.match((await cli(["net", "--filter", "/api/", "--tabId", tab])).out, /404/);
        await cli(["capture", "stop", "--tabId", tab]);

        assert.match((await cli(["shot", "--tabId", tab])).out, /shot: .*\.png/);
        assert.match((await cli(["shot", "--selector", "#menuBtn", "--tabId", tab])).out, /shot: .*\.png/);
        assert.match((await cli(["shot", "--full", "--jpeg", "--tabId", tab])).out, /shot: .*\.jpg/);

        // Strict CSP fallback via CDP Runtime.evaluate.
        const cspTab = String(JSON.parse((await cli(["new", `${fixture.url}/csp`, "--json"])).out).tabId);
        assert.equal((await cli(["eval", "window.secret", "--tabId", cspTab])).out, "csp-ok");

        // Guard rejects mutating user tab, allows reading it.
        const blocked = await cli(["scroll", "+0", "--tabId", String(userTabId)]);
        assert.notEqual(blocked.code, 0);
        assert.match(blocked.err, /GUARD/);
        assert.equal((await cli(["title", "--tabId", String(userTabId)])).code, 0);

        // Extension popup page exists, renders title, and is protected against script injection.
        const pinnedExtId = JSON.parse(readFileSync(configPath, "utf8")).extId;
        assert.match(pinnedExtId, /^[a-p]{32}$/);
        const popTab = JSON.parse((await cli(["new", `chrome-extension://${pinnedExtId}/popup.html`, "--json"])).out);
        assert.equal(popTab.title, "AniEvo Brave Bridge");
        const popEval = await cli(["eval", "1+1", "--tabId", String(popTab.tabId)]);
        assert.notEqual(popEval.code, 0);

        const closed = await cli(["close-group"]);
        assert.match(closed.out, /Group "Antigravity": ditutup 3 tab/);
    });

    await t.test("per-session tab groups isolate parallel agents", async () => {
        const a = JSON.parse((await cli(["new", `${fixture.url}/`, "--session", "alpha", "--json"])).out);
        const b = JSON.parse((await cli(["new", `${fixture.url}/`, "--json"], { BRAVE_BRIDGE_SESSION: "beta" })).out);
        assert.equal(a.group, "Antigravity-alpha");
        assert.equal(b.group, "Antigravity-beta");

        // Cross-session mutation is blocked.
        const cross = await cli(["scroll", "+0", "--tabId", String(b.tabId), "--session", "alpha"]);
        assert.notEqual(cross.code, 0);
        assert.match(cross.err, /group sesi lain/);

        // Closing alpha leaves beta untouched.
        await cli(["close-group", "--session", "alpha"]);
        const betaTabs = JSON.parse((await cli(["tabs", "--session", "beta", "--json"])).out);
        assert.equal(betaTabs.length, 1);
        assert.equal(betaTabs[0].id, b.tabId);

        // --all-sessions cleans up remaining agent session groups without touching userTabId.
        await cli(["close-group", "--all-sessions"]);
        const allLeft = JSON.parse((await cli(["tabs", "--all-sessions", "--json"])).out);
        assert.equal(allLeft.length, 0);
        const userStillAlive = JSON.parse((await cli(["tabs", "--json"])).out).some((x) => x.id === userTabId);
        assert.equal(userStillAlive, true);
    });

    // --------------------------------------------------------- 3. MCP stdio server
    await t.test("MCP server end-to-end", async () => {
        const p = spawn(process.execPath, [MCP], { env, stdio: ["pipe", "pipe", "ignore"] });
        t.after(() => !p.killed && p.kill());
        let buf = "";
        const pending = new Map();
        p.stdout.on("data", (c) => {
            buf += c.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                const m = JSON.parse(line);
                pending.get(m.id)?.(m);
            }
        });
        let seq = 0;
        const rpc = (method, params) =>
            new Promise((res) => {
                const id = ++seq;
                pending.set(id, res);
                p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            });
        const call = (name, args) => rpc("tools/call", { name, arguments: args }).then((r) => r.result);

        const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ci", version: "1" } });
        assert.equal(init.result.serverInfo.name, "brave-bridge");
        p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

        const tools = (await rpc("tools/list", {})).result.tools;
        assert.equal(tools.length, 27);

        const opened = JSON.parse((await call("browser_open", { url: `${fixture.url}/`, session: "mcp1" })).content[0].text);
        assert.equal(opened.group, "Antigravity-mcp1");
        const tabId = opened.tabId;

        const snap = (await call("browser_snapshot", { tabId })).content[0].text;
        assert.match(snap, /@\d+ button "Trusted\?"/);

        await call("browser_click", { tabId, selector: "#trusted", trusted: true });
        assert.equal((await call("browser_text", { tabId, selector: "#trustedResult" })).content[0].text, "true");

        const shot = await call("browser_screenshot", { tabId });
        assert.equal(shot.content[0].type, "image");
        assert.ok(shot.content[0].data.length > 100);

        const guardErr = await call("browser_scroll", { tabId: userTabId, to: "+0" });
        assert.equal(guardErr.isError, true);
        assert.match(guardErr.content[0].text, /GUARD/);

        const closed = JSON.parse((await call("browser_close_group", { session: "mcp1" })).content[0].text);
        assert.equal(closed.count, 1);
        p.stdin.end();
    });
});
