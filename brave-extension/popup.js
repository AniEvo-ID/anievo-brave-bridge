const COLOR_HEX = {
    purple: "#a855f7",
    blue: "#3b82f6",
    cyan: "#06b6d4",
    green: "#22c55e",
    orange: "#f97316",
    pink: "#ec4899",
    yellow: "#eab308",
    red: "#ef4444",
    grey: "#94a3b8",
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function setToast(txt) {
    $("toast").textContent = txt || "";
}

async function refresh() {
    const st = await send({ type: "popup-state" }).catch(() => null);
    if (!st || !st.ok) {
        $("statusPill").className = "pill off";
        $("statusText").textContent = "Error";
        return;
    }

    $("verText").textContent = `Extension v${st.extVersion}`;
    $("statusPill").className = st.connected ? "pill on" : "pill off";
    $("statusText").textContent = st.connected ? "Connected" : "Offline";
    $("wsVal").textContent = st.wsUrl.replace(/^ws:\/\//, "");
    $("tabsVal").textContent = String(st.totalTabs);
    $("cdpVal").textContent = st.cdpAttached.length ? `${st.cdpAttached.length} tab` : "0";
    $("cdpVal").className = st.cdpAttached.length ? "v warn" : "v";

    // Probe server /health for server version & mismatch check.
    try {
        const h = await fetch(`${st.httpBase}/health`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
        const mismatch = h.server && h.server !== st.extVersion;
        $("srvVal").textContent = `v${h.server || "?"}${mismatch ? " (mismatch)" : ""}`;
        $("srvVal").className = mismatch ? "v warn" : "v";
    } catch {
        $("srvVal").textContent = "unreachable";
        $("srvVal").className = "v warn";
    }

    const list = $("groupList");
    list.textContent = "";
    const totalAgent = st.agentGroups.reduce((n, g) => n + g.count, 0);
    $("agentTotal").textContent = `${totalAgent} tab`;
    $("closeAllBtn").disabled = totalAgent === 0;

    if (!st.agentGroups.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Tidak ada tab agent aktif.";
        list.appendChild(empty);
        return;
    }

    for (const g of st.agentGroups) {
        const row = document.createElement("div");
        row.className = "grp";

        const left = document.createElement("div");
        left.className = "grp-left";

        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = COLOR_HEX[g.color] || COLOR_HEX.purple;

        const name = document.createElement("span");
        name.className = "grp-name";
        name.textContent = g.title;

        const cnt = document.createElement("span");
        cnt.className = "grp-count";
        cnt.textContent = `(${g.count})`;

        left.append(sw, name, cnt);

        const btn = document.createElement("button");
        btn.className = "grp-close";
        btn.textContent = "Close";
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            const r = await send({ type: "popup-close-group", group: g.title });
            setToast(r && r.ok ? `Ditutup ${r.count} tab (${g.title})` : "Gagal menutup group");
            await refresh();
        });

        row.append(left, btn);
        list.appendChild(row);
    }
}

$("closeAllBtn").addEventListener("click", async () => {
    $("closeAllBtn").disabled = true;
    const r = await send({ type: "popup-close-group", all: true });
    setToast(r && r.ok ? `Ditutup ${r.count} tab agent` : "Gagal menutup tab");
    await refresh();
});

$("reconnectBtn").addEventListener("click", async () => {
    setToast("Menyambungkan ulang…");
    const r = await send({ type: "popup-reconnect" });
    setToast(r && r.connected ? "Tersambung!" : "Server belum merespon");
    await refresh();
});

$("reloadBtn").addEventListener("click", () => {
    chrome.runtime.reload();
    window.close();
});

refresh();
