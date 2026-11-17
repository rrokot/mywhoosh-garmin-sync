const STORAGE_KEYS = [
  "lastError",
  "lastErrorAt",
  "lastUploadAt",
  "lastUploadSummary",
  "lastUserMessage",
  "lastUserMessageAt",
  "syncStatusAt",
  "syncInProgress",
  "syncProgress",
  "syncStatus",
  "syncStatusMessage"
];

const DOM = {
  actionStatus: document.getElementById("action-status"),
  btnClearCache: document.getElementById("btn-clear-cache"),
  btnCopyLogs: document.getElementById("btn-copy-logs"),
  btnNew: document.getElementById("btn-new"),
  progressBar: document.getElementById("sync-progress"),
  progressSection: document.getElementById("sync-result"),
  progressCopy: document.getElementById("progress-copy"),
  progressMeta: document.getElementById("progress-meta")
};

const transientStatus = {
  text: "",
  tone: "muted"
};
const CLEAR_CACHE_CONFIRM_TIMEOUT_MS = 30000;
const clearCacheConfirm = {
  armed: false,
  timer: null
};
const RUN_START_MARKER = "[info] Sync run started";
const STALE_RUNNING_MS = 5 * 60 * 1000;

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

function setActionStatus(text, tone = "muted") {
  transientStatus.text = text || "";
  transientStatus.tone = tone;
  DOM.actionStatus.textContent = transientStatus.text;
  DOM.actionStatus.className = `action-status action-status-${transientStatus.tone}`;
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function activityCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function selectLastRunLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || "");
    if (line.includes(RUN_START_MARKER)) {
      return lines.slice(index);
    }
  }

  return lines.slice(-80);
}

function buildViewModel(_tab, data = {}) {
  const statusAt = Date.parse(String(data.syncStatusAt || ""));
  const stale = Boolean(data.syncInProgress) && Number.isFinite(statusAt) && Date.now() - statusAt > STALE_RUNNING_MS;
  const running = Boolean(data.syncInProgress) && !stale;
  const status = String(data.syncStatus || "");
  const progress = data.syncProgress || {};
  const summary = data.lastUploadSummary;
  const phase = String(progress.phase || "");
  const hasCounters = progress.current != null && progress.total != null &&
    Number.isFinite(Number(progress.current)) && Number.isFinite(Number(progress.total));
  const total = activityCount(progress.total);
  const current = Math.min(activityCount(progress.current), total);
  let progressCopy = "";
  let progressMeta = "";
  let tone = "neutral";
  let showProgress = false;

  if (running) {
    if (phase === "waiting_garmin_login" || phase === "waiting_mywhoosh_login") {
      const service = phase === "waiting_garmin_login" ? "Garmin" : "MyWhoosh";
      progressCopy = `Sign in to ${service} in the opened tab.`;
    } else if (phase.includes("login")) {
      progressCopy = "Continuing…";
    } else {
      progressCopy = hasCounters && total > 0 ? `${current} / ${total} processed` : "Checking activities…";
      showProgress = hasCounters && total > 0 && phase === "uploading";
    }
    tone = "running";
  } else if (stale || status === "aborted") {
    progressCopy = "Sync interrupted";
    tone = "warning";
  } else if (status === "error") {
    progressCopy = "Sync failed";
    progressMeta = String(data.lastUserMessage || data.lastError || "").replace(/^Error:\s*/i, "");
    if (progressMeta === progressCopy) progressMeta = "";
    tone = "error";
  } else if (summary && (status === "finished" || !status)) {
    progressCopy = `Uploaded: ${activityCount(summary.uploaded)}`;
    progressMeta = formatDateTime(data.lastUploadAt || data.lastUserMessageAt);
    tone = "neutral";
  }

  return {
    actionStatusText: transientStatus.text,
    actionStatusTone: transientStatus.tone,
    actionsEnabled: !running,
    cacheClearEnabled: !running,
    progressCopy, progressMeta, tone,
    showResult: Boolean(progressCopy), showProgress,
    progressValue: current,
    progressMax: Math.max(total, 1)
  };
}

async function refreshView() {
  const data = await chrome.storage.local.get(STORAGE_KEYS);
  const view = buildViewModel(null, data);
  DOM.progressSection.hidden = !view.showResult;
  DOM.progressSection.dataset.tone = view.tone;
  DOM.progressCopy.textContent = view.progressCopy;
  DOM.progressMeta.textContent = view.progressMeta;
  DOM.progressBar.hidden = !view.showProgress;
  DOM.progressBar.max = view.progressMax;
  DOM.progressBar.value = view.progressValue;
  DOM.btnNew.disabled = !view.actionsEnabled;
  DOM.btnNew.ariaBusy = String(!view.actionsEnabled);
  DOM.btnClearCache.disabled = !view.cacheClearEnabled;
  if (clearCacheConfirm.armed && !view.cacheClearEnabled) disarmClearCache();
}

async function start() {
  const tab = await getActiveTab();
  setActionStatus("", "muted");

  const response = await chrome.runtime.sendMessage({
    type: "START_SYNC",
    tabId: tab?.id ?? null
  });

  if (!response?.ok) {
    setActionStatus(response?.error || "Could not start sync.", "error");
    return;
  }
}

async function copyLogs() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SYNC_LOG_LINES" });
  if (!response?.ok) {
    setActionStatus(response?.error || "Could not read logs.", "error");
    return;
  }

  const lines = Array.isArray(response?.lines) ? response.lines : [];
  if (lines.length === 0) {
    setActionStatus("No logs yet.", "muted");
    return;
  }

  const lastRunLines = selectLastRunLines(lines);
  await copyText(lastRunLines.join("\n"));
  setActionStatus(`Copied ${lastRunLines.length} log lines from last run.`, "success");
}

function disarmClearCache() {
  if (clearCacheConfirm.timer) {
    clearTimeout(clearCacheConfirm.timer);
    clearCacheConfirm.timer = null;
  }
  clearCacheConfirm.armed = false;
  DOM.btnClearCache.textContent = "Clear Cache";
  DOM.btnClearCache.classList.remove("utility-btn-danger");
}

function armClearCache() {
  clearCacheConfirm.armed = true;
  DOM.btnClearCache.textContent = "Confirm Clear";
  DOM.btnClearCache.classList.add("utility-btn-danger");
  setActionStatus(
    "Clear saved sign-in, sync history and logs? Click Confirm Clear to reset.",
    "muted"
  );
  clearCacheConfirm.timer = setTimeout(() => {
    disarmClearCache();
    setActionStatus("", "muted");
  }, CLEAR_CACHE_CONFIRM_TIMEOUT_MS);
}

// A window.confirm() modal is unreliable inside an MV3 popup: it can dismiss
// the popup and kill the pending handler, so the confirmation is inline.
async function clearCache() {
  if (!clearCacheConfirm.armed) {
    armClearCache();
    return;
  }

  disarmClearCache();
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_EXTENSION_CACHE" });
  if (!response?.ok) {
    setActionStatus(response?.error || "Could not clear cache.", "error");
    return;
  }

  setActionStatus("Extension cache cleared.", "success");
  await refreshView();
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  const hasRelevantChange = STORAGE_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(changes, key)
  );
  if (hasRelevantChange) {
    refreshView().catch(() => {});
  }
}

DOM.btnCopyLogs?.addEventListener("click", disarmClearCache);
DOM.btnNew?.addEventListener("click", disarmClearCache);

DOM.btnNew?.addEventListener("click", () => {
  start().catch((error) => setActionStatus(String(error?.message || error), "error"));
});

DOM.btnCopyLogs?.addEventListener("click", () => {
  copyLogs().catch((error) => setActionStatus(String(error?.message || error), "error"));
});

DOM.btnClearCache?.addEventListener("click", () => {
  clearCache().catch((error) => setActionStatus(String(error?.message || error), "error"));
});

chrome.storage.onChanged.addListener(handleStorageChange);
window.addEventListener("pagehide", () => {
  chrome.storage.onChanged.removeListener(handleStorageChange);
});

refreshView().catch((error) => {
  setActionStatus(String(error?.message || error), "error");
});
