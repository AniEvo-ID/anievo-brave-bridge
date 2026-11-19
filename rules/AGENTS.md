# AniEvo Brave Bridge Rules

When the user asks to access, inspect, test, or control their running **Brave** browser:

1. **Never close or relaunch** the user's browser. Use the `browser_*` MCP tools exposed by `anievo-brave-bridge` (or fallback CLI `brave-bridge.mjs`).
2. **Work in background agent tab groups**:
   - Always open your own tab with `browser_open` (`new <url>`), which opens in the **background** inside the `"Antigravity"` tab group (or `"Antigravity-<session>"` when `session` is provided for parallel agents) without stealing the user's focus.
   - Never pass `foreground: true` or `--activate` unless the user explicitly asks to bring the tab to the front.
   - Never mutate tabs outside the agent tab group unless the user explicitly asks (`--force`). Reading user tab titles/URLs/text is allowed.
3. **Clean up when finished**:
   - Always call `browser_close_group` (`close-group`) once the task is complete so agent tabs do not pile up.
