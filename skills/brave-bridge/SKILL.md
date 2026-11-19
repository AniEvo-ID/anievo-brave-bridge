---
name: brave-bridge
description: >-
  Control a running Brave or Chromium browser (without closing or relaunching) using
  the AniEvo Brave Bridge MCP tools (browser_*) or CLI (brave-bridge.mjs). Activate
  whenever the user asks to check, open, test, debug, or interact with pages in Brave.
---

# AniEvo Brave Bridge

Controls a live Brave/Chromium browser over a localhost-only authenticated WebSocket bridge + MV3 extension.

## Recommended Workflow (MCP `browser_*` tools)

1. **Verify connection** (if unsure): `browser_status` — ensure `ext.ok === true`. If the extension is offline, ask the user to load/enable `brave-extension/` in `brave://extensions`.
2. **Open a background agent tab**:
   - `browser_open({ url: "https://...", session: "optional-worker-id" })` -> returns `tabId`.
   - Always pass `tabId` on subsequent tool calls.
3. **Inspect & interact using `@refs`**:
   - `browser_snapshot({ tabId })` -> lists headings and interactive elements (`@1`, `@2`, ...).
   - `browser_fill({ tabId, selector: "@2", value: "..." })`
   - `browser_click({ tabId, selector: "@5" })` (supports `double: true`, `button: "right"`, `trusted: true`, `text`, `frame: "all"`).
   - `browser_drag({ tabId, from: "#a", to: "#b" })`
4. **Dialogs, State, Emulation & Visuals**:
   - Pre-arm before clicking buttons that open `alert`/`confirm`/`prompt`: `browser_dialog({ tabId, action: "once-accept", promptText: "..." })`.
   - Test mobile/dark-mode layouts without resizing the user's window: `browser_emulate({ tabId, preset: "iphone", colorScheme: "dark" })` -> reset with `preset: "reset"`.
   - Debug console & network: `browser_capture({ tabId, action: "start" })` -> `browser_console` / `browser_network` -> `browser_capture({ tabId, action: "stop" })`.
   - Inspect origin cookies (`HttpOnly` included) & storage: `browser_cookies`, `browser_storage`.
   - Capture visuals or vector PDFs in the background: `browser_screenshot`, `browser_pdf`.
5. **Clean up**:
   - Call `browser_close_group({ session: "optional-worker-id" })` when done.

## Guardrails & Limits
- Cannot inject into `brave://` or `chrome://` internal pages.
- Native browser shortcuts (e.g. `Ctrl+T`) cannot be triggered from web/CDP key events.
- CDP features (`trusted: true`, `browser_screenshot` on background tabs, `browser_capture`, `browser_emulate`, `browser_cookies`, `browser_pdf`) briefly display Brave's debugging banner while attached.
