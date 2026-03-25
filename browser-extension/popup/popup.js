const STORAGE_KEYS = [
  "lastError",
  "lastErrorAt",
  "lastUploadAt",
  "lastUploadSummary",
  "lastUserMessage",
  "lastUserMessageAt",
  "mywhooshAuth",
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
  metricDuplicate: document.getElementById("metric-duplicate"),
  metricFailed: document.getElementById("metric-failed"),
  metricProgress: document.getElementById("metric-progress"),
  metricUploaded: document.getElementById("metric-uploaded"),
  progressCopy: document.getElementById("progress-copy"),
  progressMeta: document.getElementById("progress-meta"),
  stateBadge: document.getElementById("state-badge"),
  stateCopy: document.getElementById("state-copy"),
  stateMeta: document.getElementById("state-meta")
};

const transientStatus = {
  text: "",
  tone: "muted"
};
const RUN_START_MARKER = "[info] Extension icon clicked";
const STALE_RUNNING_MS = 5 * 60 * 1000;

function isMyWhooshUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname === "event.mywhoosh.com" || parsed.hostname.endsWith(".mywhoosh.com");
  } catch (_) {
    return false;
  }
}

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

function setMetric(element, value) {
  element.textContent = value;
}

function setBadge(label, tone) {
  DOM.stateBadge.textContent = label;
  DOM.stateBadge.className = `badge badge-${tone}`;
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

function buildFinishedStatusText(summary) {
  const totalNew = Number(summary?.totalNew || 0);
  const uploaded = Number(summary?.uploaded || 0);
  const duplicate = Number(summary?.duplicate || 0);
  const failed = Number(summary?.failed || 0);

  if (totalNew <= 0) {
    return "No new activities.";
  }
  if (uploaded > 0 && duplicate === 0 && failed === 0) {
    return "Upload complete.";
  }
  if (duplicate > 0 && uploaded === 0 && failed === 0) {
    return "Already in Garmin.";
  }
  if (failed > 0 && uploaded === 0 && duplicate === 0) {
    return "Sync failed.";
  }
  return "Sync complete.";
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

function buildViewModel(tab, data) {
  const hasTab = Boolean(tab?.id);
  const tabReady = hasTab && isMyWhooshUrl(tab.url || "");
  const hasStoredMyWhooshAuth = Boolean(String(data?.mywhooshAuth?.webToken || "").trim());
  const syncStatusAt = Date.parse(String(data?.syncStatusAt || ""));
  const hasValidSyncStatusAt = Number.isFinite(syncStatusAt);
  const syncStateAgeMs = hasValidSyncStatusAt ? Date.now() - syncStatusAt : 0;
  const staleRunning = Boolean(data?.syncInProgress) && hasValidSyncStatusAt && syncStateAgeMs > STALE_RUNNING_MS;
  const syncInProgress = Boolean(data?.syncInProgress) && !staleRunning;
  const syncStatus = String(data?.syncStatus || "");
  const progress =
    data?.syncProgress && typeof data.syncProgress === "object" ? data.syncProgress : null;
  const progressPhase = String(progress?.phase || "");
  const summary =
    data?.lastUploadSummary && typeof data.lastUploadSummary === "object"
      ? data.lastUploadSummary
      : null;

  let stateBadgeLabel = "Ready";
  let stateBadgeTone = "ready";
  let stateCopy = "";
  let stateMeta = "";

  if (syncInProgress) {
    stateBadgeLabel = "Running";
    stateBadgeTone = "running";
    stateCopy = data?.syncStatusMessage || "Sync in progress.";
    stateMeta = hasStoredMyWhooshAuth && !tabReady ? "Saved MyWhoosh session" : "";
  } else if (staleRunning) {
    stateBadgeLabel = "Ready";
    stateBadgeTone = "ready";
    stateCopy = "Previous sync was interrupted. Start again.";
  } else if (!hasStoredMyWhooshAuth && !tabReady) {
    stateBadgeLabel = "Login Needed";
    stateBadgeTone = "blocked";
    stateCopy = "Click sync to open MyWhoosh login.";
  } else if (data?.syncStatus === "error") {
    stateCopy = "Ready to sync again. The previous run ended with an error.";
  } else if (data?.syncStatus === "aborted") {
    stateCopy = "Ready to sync again. The previous run was aborted.";
  }

  let progressCopy = "No sync running.";
  let progressMeta = "";
  let progressMetrics = {
    processed: "--",
    uploaded: "--",
    duplicate: "--",
    failed: "--"
  };

  if (syncInProgress && progress) {
    if (progressPhase === "waiting_garmin_login") {
      progressCopy = "Waiting for Garmin login...";
      progressMeta = "Complete sign-in in opened Garmin tab.";
    } else if (progressPhase === "waiting_mywhoosh_login") {
      progressCopy = "Waiting for MyWhoosh login...";
      progressMeta = "Complete sign-in in opened MyWhoosh tab.";
    } else if (progressPhase === "resuming_after_garmin_login") {
      progressCopy = "Garmin login detected. Continuing sync...";
    } else if (progressPhase === "resuming_after_mywhoosh_login") {
      progressCopy = "MyWhoosh login detected. Continuing sync...";
    } else {
      progressCopy = data?.syncStatusMessage || "Sync in progress.";
      progressMeta = `${progress.current} of ${progress.total} processed`;
    }
    progressMetrics = {
      processed: `${progress.current} / ${progress.total}`,
      uploaded: String(progress.uploaded),
      duplicate: String(progress.duplicate),
      failed: String(progress.failed)
    };
  } else if (syncInProgress) {
    progressCopy = data?.syncStatusMessage || "Sync in progress.";
  } else if ((syncStatus === "error" || syncStatus === "aborted") && data?.lastUserMessage) {
    progressCopy = data.lastUserMessage;
    progressMeta = formatDateTime(data?.lastUserMessageAt || data?.lastErrorAt);
  } else if (staleRunning) {
    progressCopy = "Previous sync was interrupted.";
    progressMeta = hasValidSyncStatusAt ? formatDateTime(syncStatusAt) : "";
  } else if (summary && (syncStatus === "finished" || !syncStatus)) {
    progressCopy = buildFinishedStatusText(summary);
    progressMeta = formatDateTime(data?.lastUploadAt || data?.lastUserMessageAt) || "";
    progressMetrics = {
      processed: `${summary.totalNew} / ${summary.totalNew}`,
      uploaded: String(summary.uploaded),
      duplicate: String(summary.duplicate),
      failed: String(summary.failed)
    };
  } else if (data?.lastUserMessage) {
    progressCopy = data.lastUserMessage;
    progressMeta = formatDateTime(data?.lastUserMessageAt || data?.lastErrorAt);
  }

  const actionsEnabled = !syncInProgress;
  const cacheClearEnabled = !syncInProgress;

  return {
    actionStatusText: transientStatus.text,
    actionStatusTone: transientStatus.tone,
    actionsEnabled,
    cacheClearEnabled,
    progressCopy,
    progressMeta,
    progressMetrics,
    stateBadgeLabel,
    stateBadgeTone,
    stateCopy,
    stateMeta
  };
}

async function refreshView() {
  const [tab, data] = await Promise.all([getActiveTab(), chrome.storage.local.get(STORAGE_KEYS)]);
  const view = buildViewModel(tab, data);

  setBadge(view.stateBadgeLabel, view.stateBadgeTone);
  DOM.stateCopy.textContent = view.stateCopy;
  DOM.stateMeta.textContent = view.stateMeta;
  DOM.progressCopy.textContent = view.progressCopy;
  DOM.progressMeta.textContent = view.progressMeta;

  setMetric(DOM.metricProgress, view.progressMetrics.processed);
  setMetric(DOM.metricUploaded, view.progressMetrics.uploaded);
  setMetric(DOM.metricDuplicate, view.progressMetrics.duplicate);
  setMetric(DOM.metricFailed, view.progressMetrics.failed);
  DOM.actionStatus.textContent = view.actionStatusText;
  DOM.actionStatus.className = `action-status action-status-${view.actionStatusTone}`;

  DOM.btnNew.disabled = !view.actionsEnabled;
  DOM.btnClearCache.disabled = !view.cacheClearEnabled;
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

async function clearCache() {
  const confirmed = window.confirm(
    "Clear extension cache, processed activities, statuses, and logs?"
  );
  if (!confirmed) {
    return;
  }

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
window.addEventListener("unload", () => {
  chrome.storage.onChanged.removeListener(handleStorageChange);
});

refreshView().catch((error) => {
  setActionStatus(String(error?.message || error), "error");
});
