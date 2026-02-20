async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function copyText(text) {
  const payload = String(text || "");
  if (!payload) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(payload);
      return;
    } catch (_) {
      // Fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = payload;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text || "";
  }
}

async function refreshStatus() {
  const data = await chrome.storage.local.get([
    "syncStatus",
    "syncStatusMessage",
    "syncInProgress",
    "lastUserMessage",
    "lastUserMessageAt"
  ]);

  if (data?.syncInProgress && data?.syncStatusMessage) {
    setStatus(`Running: ${data.syncStatusMessage}`);
    return;
  }

  if (data?.lastUserMessage) {
    setStatus(`Last: ${data.lastUserMessage}`);
    return;
  }

  setStatus("No runs yet.");
}

async function start(mode) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("Active tab not found.");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "START_SYNC",
    mode,
    tabId: tab.id
  });

  if (!response?.ok) {
    setStatus(response?.error || "Could not start sync.");
    return;
  }

  setStatus(mode === "latest" ? "Started: latest activity..." : "Started: new activities...");
  await refreshStatus();
}

async function copyLogs() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SYNC_LOG_LINES" });
  if (!response?.ok) {
    setStatus(response?.error || "Could not read logs.");
    return;
  }

  const lines = Array.isArray(response?.lines) ? response.lines : [];
  if (lines.length === 0) {
    setStatus("No logs yet.");
    return;
  }

  const tailLines = lines.slice(-300);
  await copyText(tailLines.join("\n"));
  setStatus(`Copied ${tailLines.length} log lines.`);
}

document.getElementById("btn-new")?.addEventListener("click", () => {
  start("new").catch((error) => setStatus(String(error?.message || error)));
});

document.getElementById("btn-latest")?.addEventListener("click", () => {
  start("latest").catch((error) => setStatus(String(error?.message || error)));
});

document.getElementById("btn-copy-logs")?.addEventListener("click", () => {
  copyLogs().catch((error) => setStatus(String(error?.message || error)));
});

refreshStatus().catch(() => {});
setInterval(() => {
  refreshStatus().catch(() => {});
}, 1200);
