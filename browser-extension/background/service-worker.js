(() => {
  const MWG = globalThis.MWG;
  const NO_ACTIVITIES_PROGRESS_INTERVAL_MS = 12000;
  const PROGRESS_NOTIFY_EVERY_N_ITEMS = 3;
  const {
    EXTENSION_VERSION,
    LOG_LINES_STORAGE,
    activityKey,
    appendLog,
    collectMyWhooshAuth,
    ensureStrictStateMigration,
    errorText,
    extractFileId,
    fetchAllMyWhooshActivities,
    fetchLatestNewMyWhooshActivity,
    fetchMyWhooshDownloadUrl,
    getProcessedKeysMap,
    isMyWhooshUrl,
    notify,
    saveLastError,
    setProcessedKeysMap,
    setUserStatus,
    showCopyableText,
    uploadOne
  } = MWG;

  function nowIso() {
    return new Date().toISOString();
  }

  function buildLastUserFields(message) {
    return {
      lastUserMessage: message,
      lastUserMessageAt: nowIso()
    };
  }

  function modeLabel(mode) {
    return mode === "latest" ? "latest" : "new";
  }

  function modeText(mode, textNew, textLatest) {
    return mode === "latest" ? textLatest : textNew;
  }

  async function setRunningStatus(message) {
    await setUserStatus("running", message, {
      syncInProgress: true
    });
  }

  async function setTerminalStatus(status, message, extra = {}) {
    await setUserStatus(status, message, {
      syncInProgress: false,
      ...buildLastUserFields(message),
      ...extra
    });
  }

  async function notifyAndExposeMessage(tabId, message) {
    notify(message);
    await showCopyableText(tabId, message);
  }

  function buildSummaryMessage(summary, mode, migrationSuffix) {
    const firstFailed = summary.items.find((item) => item.status === "failed");
    const failSuffix = firstFailed?.detail ? ` | first fail: ${firstFailed.detail}` : "";
    const latestSuffix = mode === "latest" ? " | mode: latest" : "";

    return `Uploaded: ${summary.uploaded}, Duplicate: ${summary.duplicate}, Failed: ${summary.failed}, Skipped: ${summary.skipped}${latestSuffix}${migrationSuffix}${failSuffix}`;
  }

  function createProgressReporter(mode) {
    let lastProgressNotifiedAt = 0;
    let lastProgressCurrent = -1;

    return async (progress) => {
      const current = Number(progress?.current || 0);
      const total = Number(progress?.total || 0);
      const summary = progress?.summary || {};
      const phase = progress?.phase || "uploading";
      const now = Date.now();
      const shouldNotify =
        phase === "finished" ||
        current === 0 ||
        current === total ||
        current % PROGRESS_NOTIFY_EVERY_N_ITEMS === 0 ||
        now - lastProgressNotifiedAt >= NO_ACTIVITIES_PROGRESS_INTERVAL_MS;

      if (!shouldNotify || current === lastProgressCurrent) {
        return;
      }

      lastProgressCurrent = current;
      lastProgressNotifiedAt = now;

      const text =
        total <= 0
          ? `Sync (${mode}): no activities | Found: ${summary.totalFound || 0}, Skipped: ${summary.skipped || 0}`
          : `Sync (${mode}): ${current}/${total} | Uploaded: ${summary.uploaded || 0}, Duplicate: ${summary.duplicate || 0}, Failed: ${summary.failed || 0}`;

      notify(text);
      await appendLog("info", "Sync progress", {
        phase,
        current,
        total,
        uploaded: summary.uploaded || 0,
        duplicate: summary.duplicate || 0,
        failed: summary.failed || 0,
        skipped: summary.skipped || 0
      });
      await setRunningStatus(text);
    };
  }

  async function handleUploadNewMyWhooshActivities(token, onProgress = null, options = {}) {
    await appendLog("info", "MyWhoosh sync started");
    const onlyLatest = Boolean(options?.onlyLatest);
    const processed = await getProcessedKeysMap();
    let selectedActivities = [];
    let skippedCount = 0;

    if (onlyLatest) {
      const latestSelection = await fetchLatestNewMyWhooshActivity(token, processed);
      selectedActivities = latestSelection.activity ? [latestSelection.activity] : [];
      skippedCount = Math.max(0, latestSelection.scannedCount - selectedActivities.length);
    } else {
      const activities = await fetchAllMyWhooshActivities(token);
      const newActivities = activities.filter((activity) => !processed[activityKey(activity)]);
      selectedActivities = newActivities;
      skippedCount = activities.length - selectedActivities.length;
    }

    const summary = {
      mode: "mywhoosh_api",
      scope: onlyLatest ? "latest" : "new",
      totalFound: skippedCount + selectedActivities.length,
      totalNew: selectedActivities.length,
      skipped: skippedCount,
      uploaded: 0,
      duplicate: 0,
      failed: 0,
      items: []
    };

    let changed = false;
    if (typeof onProgress === "function") {
      await onProgress({
        phase: "uploading",
        current: 0,
        total: selectedActivities.length,
        summary
      });
    }

    for (let i = 0; i < selectedActivities.length; i += 1) {
      const activity = selectedActivities[i];
      const key = activityKey(activity);
      const fileId = extractFileId(activity);

      try {
        if (!fileId) {
          throw new Error("Missing activity fileId");
        }

        const downloadUrl = await fetchMyWhooshDownloadUrl(token, fileId);
        const result = await uploadOne(downloadUrl, i + 1);

        if (result.status === "uploaded") {
          summary.uploaded += 1;
        } else if (result.status === "duplicate") {
          summary.duplicate += 1;
        }

        processed[key] = true;
        changed = true;

        summary.items.push({
          fileId,
          key,
          status: result.status,
          detail: result.detail,
          filename: result.filename
        });
        await appendLog("info", "Activity processed", {
          fileId,
          key,
          status: result.status,
          detail: result.detail,
          filename: result.filename
        });
      } catch (error) {
        summary.failed += 1;
        summary.items.push({
          fileId,
          key,
          status: "failed",
          detail: errorText(error)
        });
        await appendLog("error", "Activity failed", {
          fileId,
          key,
          error: errorText(error)
        });
      }

      if (typeof onProgress === "function") {
        await onProgress({
          phase: "uploading",
          current: i + 1,
          total: selectedActivities.length,
          summary
        });
      }
    }

    if (changed) {
      await setProcessedKeysMap(processed);
    }

    await chrome.storage.local.set({
      lastUploadSummary: summary,
      lastUploadAt: nowIso()
    });
    await appendLog("info", "MyWhoosh sync finished", summary);
    if (typeof onProgress === "function") {
      await onProgress({
        phase: "finished",
        current: selectedActivities.length,
        total: selectedActivities.length,
        summary
      });
    }

    return summary;
  }

  async function runOneClickSync(tab, mode = "new") {
    const normalizedMode = modeLabel(mode);
    await appendLog("info", "Extension icon clicked", {
      tabUrl: tab?.url || "",
      mode: normalizedMode
    });
    await setUserStatus("started", `Started (${normalizedMode})`, {
      syncInProgress: true
    });

    if (!tab?.id || !isMyWhooshUrl(tab.url)) {
      const message = "Open MyWhoosh page, then click extension icon again.";
      await notifyAndExposeMessage(tab?.id, message);
      await appendLog("warn", "Sync aborted: wrong tab", { tabUrl: tab?.url || "" });
      await setTerminalStatus("aborted", message);
      return;
    }

    const migration = await ensureStrictStateMigration();
    let migrationSuffix = "";
    if (migration.migrated && migration.clearedKeys > 0) {
      migrationSuffix = ` | strict-state reset: ${migration.clearedKeys}`;
    }

    notify(modeText(
      normalizedMode,
      "Sync started: checking MyWhoosh auth...",
      "Sync started (latest): checking MyWhoosh auth..."
    ));
    await setRunningStatus(`Checking MyWhoosh auth (${normalizedMode})`);

    const authResponse = await collectMyWhooshAuth(tab.id);
    if (!authResponse?.ok) {
      await appendLog("error", "Could not read MyWhoosh auth", authResponse || null);
      throw new Error(authResponse?.error || "Could not read MyWhoosh auth from tab");
    }

    const token = authResponse.webToken;
    if (!token) {
      const message = "MyWhoosh token not found. Log in on MyWhoosh in this tab/profile first.";
      await notifyAndExposeMessage(tab?.id, message);
      await appendLog("warn", "Sync aborted: missing webToken");
      await setTerminalStatus("aborted", message);
      return;
    }

    notify(modeText(
      normalizedMode,
      "Sync started: loading MyWhoosh activities...",
      "Sync started (latest): loading MyWhoosh activities..."
    ));
    const onProgress = createProgressReporter(normalizedMode);

    const summary = await handleUploadNewMyWhooshActivities(token, onProgress, {
      onlyLatest: normalizedMode === "latest"
    });
    const message = buildSummaryMessage(summary, normalizedMode, migrationSuffix);
    await notifyAndExposeMessage(tab?.id, message);
    await setTerminalStatus("finished", message);
  }

  async function reportSyncFailure(tab, mode, error) {
    const message = errorText(error);
    const prefixedMessage = `Error: ${message}`;
    notify(prefixedMessage);
    saveLastError(message).catch(() => {});
    showCopyableText(tab?.id, prefixedMessage).catch(() => {});
    setTerminalStatus("error", prefixedMessage).catch(() => {});
    appendLog("error", "Sync run failed", {
      message,
      tabUrl: tab?.url || "",
      mode: modeLabel(mode)
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_SYNC_LOG_LINES") {
      chrome.storage.local
        .get(LOG_LINES_STORAGE)
        .then((data) => {
          sendResponse({
            ok: true,
            lines: Array.isArray(data?.[LOG_LINES_STORAGE]) ? data[LOG_LINES_STORAGE] : []
          });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: errorText(error) });
        });
      return true;
    }

    if (message?.type === "START_SYNC") {
      const tabId = Number(message.tabId);
      const mode = message.mode === "latest" ? "latest" : "new";
      if (!Number.isFinite(tabId) || tabId <= 0) {
        sendResponse({ ok: false, error: "Invalid tabId" });
        return false;
      }

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Tab not found"
          });
          return;
        }

        runOneClickSync(tab, mode).catch((error) => {
          reportSyncFailure(tab, mode, error);
        });
        sendResponse({ ok: true });
      });
      return true;
    }

    return undefined;
  });

  appendLog("info", "Background worker initialized", {
    version: EXTENSION_VERSION
  }).catch(() => {});

  chrome.action.onClicked.addListener((tab) => {
    runOneClickSync(tab).catch((error) => {
      reportSyncFailure(tab, "new", error);
    });
  });
})();
