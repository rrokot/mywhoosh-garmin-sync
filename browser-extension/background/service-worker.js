(() => {
  const MWG = globalThis.MWG;
  const MYWHOOSH_AUTH_WAIT_TIMEOUT_MS = 180000;
  const MYWHOOSH_AUTH_POLL_INTERVAL_MS = 2500;
  const NO_ACTIVITIES_PROGRESS_INTERVAL_MS = 12000;
  const PROGRESS_NOTIFY_EVERY_N_ITEMS = 3;
  const {
    clearStoredMyWhooshAuth,
    chromeTabsCreate,
    chromeTabsQuery,
    chromeTabsRemove,
    chromeTabsUpdate,
    EXTENSION_VERSION,
    LOG_LINES_STORAGE,
    MYWHOOSH_APP_ENTRY_URL,
    activityKey,
    appendLog,
    collectMyWhooshAuth,
    ensureStrictStateMigration,
    errorText,
    extractFileId,
    fetchAllMyWhooshActivities,
    fetchMyWhooshDownloadUrl,
    getProcessedKeysMap,
    getStoredMyWhooshAuth,
    isMyWhooshUrl,
    notify,
    resetGarminCaches,
    resetRuntimeCaches,
    saveLastError,
    setStoredMyWhooshAuth,
    setProcessedKeysMap,
    setUserStatus,
    uploadOne,
    wait,
    waitForTabComplete
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

  function hasMyWhooshToken(auth) {
    return Boolean(String(auth?.webToken || "").trim());
  }

  function isMyWhooshAuthError(error) {
    return Boolean(error?.mywhooshAuth) || /MyWhoosh API failed: HTTP (401|403)/i.test(errorText(error));
  }

  async function tryCollectMyWhooshAuthFromTab(tab, source = "active-tab") {
    if (!tab?.id || !isMyWhooshUrl(tab.url)) {
      return null;
    }

    const authResponse = await collectMyWhooshAuth(tab.id);
    if (!authResponse?.ok) {
      throw new Error(authResponse?.error || "Could not read MyWhoosh auth from tab");
    }

    if (!hasMyWhooshToken(authResponse)) {
      return null;
    }

    const stored = await setStoredMyWhooshAuth(authResponse, source);
    return stored ? { ...stored, source } : null;
  }

  async function resolveMyWhooshAuth(tab) {
    if (tab?.id && isMyWhooshUrl(tab.url)) {
      try {
        const tabAuth = await tryCollectMyWhooshAuthFromTab(tab, "active-tab");
        if (tabAuth) {
          return tabAuth;
        }

        await appendLog("warn", "MyWhoosh auth missing in current tab, checking stored token", {
          tabUrl: tab.url || ""
        });
      } catch (error) {
        await appendLog("warn", "Could not refresh MyWhoosh auth from current tab, checking stored token", {
          tabUrl: tab?.url || "",
          error: errorText(error)
        });
      }
    }

    const stored = await getStoredMyWhooshAuth();
    if (hasMyWhooshToken(stored)) {
      await appendLog("info", "Using stored MyWhoosh auth token", {
        pageUrl: stored.pageUrl || "",
        capturedAt: stored.capturedAt || ""
      });
      return {
        ...stored,
        source: "storage"
      };
    }

    return null;
  }

  async function openMyWhooshAuthTab(active = true) {
    const [activeTab] = await chromeTabsQuery({
      active: true,
      lastFocusedWindow: true
    });
    const authTab = await chromeTabsCreate({
      url: MYWHOOSH_APP_ENTRY_URL,
      active
    });

    if (!authTab?.id) {
      throw new Error("Could not open MyWhoosh sign-in tab");
    }

    await waitForTabComplete(authTab.id, 90000);
    return {
      tabId: authTab.id,
      previousTabId: activeTab?.id ?? null,
      cleanupDone: false
    };
  }

  async function cleanupMyWhooshAuthTab(authTab) {
    if (!authTab || authTab.cleanupDone) {
      return;
    }
    authTab.cleanupDone = true;

    if (authTab.tabId) {
      try {
        await chromeTabsRemove(authTab.tabId);
      } catch (_) {
        // Ignore already-closed tab errors.
      }
    }

    if (authTab.previousTabId) {
      try {
        await chromeTabsUpdate(authTab.previousTabId, { active: true });
      } catch (_) {
        // Ignore focus restore errors for tabs that no longer exist.
      }
    }
  }

  async function ensureMyWhooshAuthInteractive(tab) {
    await appendLog("warn", "MyWhoosh login required, opening sign-in tab", {
      tabUrl: tab?.url || ""
    });
    notify("MyWhoosh login required. Complete sign-in in opened tab.");
    await setRunningStatus("Waiting for MyWhoosh login...", {
      syncProgress: {
        phase: "waiting_mywhoosh_login"
      }
    });

    let authTab = null;
    try {
      authTab = await openMyWhooshAuthTab(true);
    } catch (error) {
      throw new Error(`Could not open MyWhoosh sign-in tab: ${errorText(error)}`);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < MYWHOOSH_AUTH_WAIT_TIMEOUT_MS) {
      await wait(MYWHOOSH_AUTH_POLL_INTERVAL_MS);

      let refreshedAuth = null;
      try {
        refreshedAuth = await tryCollectMyWhooshAuthFromTab(
          { id: authTab.tabId, url: MYWHOOSH_APP_ENTRY_URL },
          "interactive-auth-tab"
        );
      } catch (_) {
        refreshedAuth = null;
      }

      if (hasMyWhooshToken(refreshedAuth)) {
        await cleanupMyWhooshAuthTab(authTab);
        await setRunningStatus("MyWhoosh login detected. Continuing sync...", {
          syncProgress: {
            phase: "resuming_after_mywhoosh_login"
          }
        });
        await appendLog("info", "MyWhoosh auth confirmed after interactive sign-in", {
          waitedMs: Date.now() - startedAt
        });
        notify("MyWhoosh login detected. Continuing sync...");
        return refreshedAuth;
      }
    }

    throw new Error("MyWhoosh login not completed in time. Sign in on MyWhoosh tab and retry.");
  }

  async function setRunningStatus(message, extra = {}) {
    await setUserStatus("running", message, {
      syncInProgress: true,
      ...extra
    });
  }

  async function setTerminalStatus(status, message, extra = {}) {
    await setUserStatus(status, message, {
      syncInProgress: false,
      syncProgress: null,
      ...buildLastUserFields(message),
      ...extra
    });
  }

  async function recoverInterruptedSyncRun() {
    let state = null;
    try {
      state = await chrome.storage.local.get([
        "syncInProgress",
        "syncStatus",
        "syncStatusAt",
        "syncStatusMessage"
      ]);
    } catch (_) {
      return;
    }

    if (!state?.syncInProgress) {
      return;
    }

    await setTerminalStatus("aborted", "Previous sync was interrupted. Start again.");
    await appendLog("warn", "Recovered interrupted sync state after worker restart", {
      previousStatus: String(state?.syncStatus || ""),
      previousMessage: String(state?.syncStatusMessage || ""),
      previousStatusAt: String(state?.syncStatusAt || "")
    });
  }

  function buildSummaryMessage(summary, migrationSuffix) {
    const firstFailed = summary.items.find((item) => item.status === "failed");
    const failSuffix = firstFailed?.detail ? ` | first fail: ${firstFailed.detail}` : "";
    const noNewSuffix = Number(summary.totalNew || 0) <= 0 ? " | no new activities" : "";

    return `Uploaded: ${summary.uploaded}, Duplicate: ${summary.duplicate}, Failed: ${summary.failed}${migrationSuffix}${noNewSuffix}${failSuffix}`;
  }

  function createProgressReporter() {
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
          ? "Sync: no activities"
          : `Sync: ${current}/${total} | Uploaded: ${summary.uploaded || 0}, Duplicate: ${summary.duplicate || 0}, Failed: ${summary.failed || 0}`;
      const progressSnapshot = {
        phase,
        mode: "new",
        current,
        total,
        totalFound: summary.totalFound || 0,
        uploaded: summary.uploaded || 0,
        duplicate: summary.duplicate || 0,
        failed: summary.failed || 0
      };

      notify(text);
      await appendLog("info", "Sync progress", {
        phase,
        current,
        total,
        uploaded: summary.uploaded || 0,
        duplicate: summary.duplicate || 0,
        failed: summary.failed || 0
      });
      await setRunningStatus(text, {
        syncProgress: progressSnapshot
      });
    };
  }

  async function handleUploadNewMyWhooshActivities(token, onProgress = null) {
    await appendLog("info", "MyWhoosh sync started");
    const processed = await getProcessedKeysMap();
    const activities = await fetchAllMyWhooshActivities(token);
    const selectedActivities = activities.filter((activity) => !processed[activityKey(activity)]);
    const alreadyProcessedCount = activities.length - selectedActivities.length;

    const summary = {
      mode: "mywhoosh_api",
      scope: "new",
      totalFound: alreadyProcessedCount + selectedActivities.length,
      totalNew: selectedActivities.length,
      alreadyProcessed: alreadyProcessedCount,
      uploaded: 0,
      duplicate: 0,
      failed: 0,
      items: []
    };

    if (alreadyProcessedCount > 0) {
      await appendLog("info", "Activities filtered before upload", {
        scope: summary.scope,
        alreadyProcessed: alreadyProcessedCount,
        selected: selectedActivities.length
      });
    }

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

  async function runOneClickSync(tab) {
    await appendLog("info", "Extension icon clicked", {
      tabUrl: tab?.url || "",
      mode: "new"
    });
    await setUserStatus("started", "Started (new)", {
      syncInProgress: true,
      syncProgress: null
    });

    const migration = await ensureStrictStateMigration();
    let migrationSuffix = "";
    if (migration.migrated && migration.clearedKeys > 0) {
      migrationSuffix = ` | strict-state reset: ${migration.clearedKeys}`;
    }

    notify("Sync started: checking MyWhoosh auth...");
    await setRunningStatus("Checking MyWhoosh auth (new)");

    let myWhooshAuth = await resolveMyWhooshAuth(tab);
    if (!hasMyWhooshToken(myWhooshAuth)) {
      myWhooshAuth = await ensureMyWhooshAuthInteractive(tab);
    }

    notify("Sync started: loading MyWhoosh activities...");
    const onProgress = createProgressReporter();
    let summary;
    try {
      summary = await handleUploadNewMyWhooshActivities(myWhooshAuth.webToken, onProgress);
    } catch (error) {
      if (!isMyWhooshAuthError(error)) {
        throw error;
      }

      await clearStoredMyWhooshAuth("mywhoosh-api-auth-error");
      await appendLog("warn", "Stored MyWhoosh auth was rejected by API", {
        source: myWhooshAuth.source || "",
        tabUrl: tab?.url || ""
      });

      let refreshedAuth = null;
      try {
        refreshedAuth = await tryCollectMyWhooshAuthFromTab(tab, "auth-retry");
      } catch (refreshError) {
        await appendLog("warn", "Could not refresh MyWhoosh auth from tab after API auth error", {
          tabUrl: tab?.url || "",
          error: errorText(refreshError)
        });
      }

      if (!hasMyWhooshToken(refreshedAuth)) {
        refreshedAuth = await ensureMyWhooshAuthInteractive(tab);
      }

      await appendLog("info", "Retrying sync with refreshed MyWhoosh auth", {
        previousSource: myWhooshAuth.source || ""
      });
      summary = await handleUploadNewMyWhooshActivities(refreshedAuth.webToken, onProgress);
    }

    const message = buildSummaryMessage(summary, migrationSuffix);
    notify(message);
    await setTerminalStatus("finished", message);
  }

  async function reportSyncFailure(tab, error) {
    const message = errorText(error);
    const prefixedMessage = `Error: ${message}`;
    notify(prefixedMessage);
    saveLastError(message).catch(() => {});
    setTerminalStatus("error", prefixedMessage).catch(() => {});
    appendLog("error", "Sync run failed", {
      message,
      tabUrl: tab?.url || "",
      mode: "new"
    }).catch(() => {});
  }

  async function clearExtensionCache() {
    const state = await chrome.storage.local.get("syncInProgress");
    if (state?.syncInProgress) {
      throw new Error("Cannot clear cache while sync is running.");
    }

    resetGarminCaches();
    resetRuntimeCaches();
    await chrome.storage.local.clear();
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

    if (message?.type === "CLEAR_EXTENSION_CACHE") {
      clearExtensionCache()
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: errorText(error) });
        });
      return true;
    }

    if (message?.type === "START_SYNC") {
      const rawTabId = message.tabId;
      const tabId =
        rawTabId === null || rawTabId === undefined || rawTabId === ""
          ? null
          : Number(rawTabId);
      if (tabId === null) {
        runOneClickSync(null).catch((error) => {
          reportSyncFailure(null, error);
        });
        sendResponse({ ok: true });
        return false;
      }

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

        runOneClickSync(tab).catch((error) => {
          reportSyncFailure(tab, error);
        });
        sendResponse({ ok: true });
      });
      return true;
    }

    return undefined;
  });

  recoverInterruptedSyncRun()
    .catch(() => {})
    .then(() =>
      appendLog("info", "Background worker initialized", {
        version: EXTENSION_VERSION
      }).catch(() => {})
    );

  chrome.action.onClicked.addListener((tab) => {
    runOneClickSync(tab).catch((error) => {
      reportSyncFailure(tab, error);
    });
  });
})();
