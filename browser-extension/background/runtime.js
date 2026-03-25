(() => {
  const MWG = globalThis.MWG;
  const GARMIN_CONNECTAPI_UPLOAD_URL = "https://connectapi.garmin.com/upload-service/upload";
  const GARMIN_SSO_BASE_URL = "https://sso.garmin.com/sso";
  const GARMIN_SSO_EMBED_URL = `${GARMIN_SSO_BASE_URL}/embed`;
  const GARMIN_SSO_SIGNIN_URL = `${GARMIN_SSO_BASE_URL}/signin`;
  const GARMIN_OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
  const GARMIN_OAUTH_USER_AGENT = "com.garmin.android.apps.connectmobile";
  const GARMIN_AUTH_WAIT_TIMEOUT_MS = 180000;
  const GARMIN_AUTH_POLL_INTERVAL_MS = 2500;
  const GARMIN_UPLOAD_STRATEGY = "connectapi/upload+oauth2-from-sso";
  const GARMIN_API_AUTH_MAX_AGE_MS = 15 * 60 * 1000;
  const PROCESSED_KEYS_STORAGE = "processedFitKeys";
  const NOTIFY_ICON = chrome.runtime.getURL("icons/icon-128.png");

  const MYWHOOSH_ACTIVITIES_URL = "https://service14.mywhoosh.com/v2/rider/profile/activities";
  const MYWHOOSH_DOWNLOAD_URL = "https://service14.mywhoosh.com/v2/rider/profile/download-activity-file";
  const MYWHOOSH_APP_ENTRY_URL = "https://event.mywhoosh.com/user/activities#profile";
  const MYWHOOSH_AES_KEY = "D9436E508087E863";
  const MYWHOOSH_DEFAULT_TYPE = "";
  const MYWHOOSH_DEFAULT_SORT = "DESC";
  const MYWHOOSH_MAX_PAGES = 100;
  const MYWHOOSH_AUTH_STORAGE = "mywhooshAuth";
  const LOGS_STORAGE = "syncLogs";
  const LOGS_LIMIT = 600;
  const LOG_LINES_STORAGE = "syncLogLines";
  const LOG_LINES_LIMIT = 1200;
  const LOG_LINE_PREFIX = "MWGLOG";
  const LOG_LINE_DATA_MAX_LEN = 700;
  const SYNC_STATE_VERSION_STORAGE = "syncStateVersion";
  const SYNC_STATE_VERSION = 2;
  const EXTENSION_VERSION = chrome.runtime.getManifest().version;
  const logState = {
    loaded: false,
    logs: [],
    lines: []
  };
  let logWriteQueue = Promise.resolve();

  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function cloneLogData(data) {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (_) {
      return String(data);
    }
  }

  function compactLogDataForLine(data) {
    if (data === undefined || data === null) {
      return "";
    }

    let text = "";
    if (typeof data === "string") {
      text = data;
    } else {
      try {
        text = JSON.stringify(data);
      } catch (_) {
        text = String(data);
      }
    }

    text = String(text || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }

    if (text.length > LOG_LINE_DATA_MAX_LEN) {
      text = `${text.slice(0, LOG_LINE_DATA_MAX_LEN)}...`;
    }

    return text;
  }

  function buildFlatLogLine(entry) {
    const prefix = `${LOG_LINE_PREFIX} ${entry.at} [${entry.level}] ${entry.message}`;
    const dataText = compactLogDataForLine(entry.data);
    return dataText ? `${prefix} | ${dataText}` : prefix;
  }

  async function ensureLogStateLoaded() {
    if (logState.loaded) {
      return;
    }

    try {
      const existingData = await chrome.storage.local.get([LOGS_STORAGE, LOG_LINES_STORAGE]);
      logState.logs = Array.isArray(existingData?.[LOGS_STORAGE]) ? existingData[LOGS_STORAGE] : [];
      logState.lines = Array.isArray(existingData?.[LOG_LINES_STORAGE]) ? existingData[LOG_LINES_STORAGE] : [];
    } catch (_) {
      logState.logs = [];
      logState.lines = [];
    }

    logState.loaded = true;
  }

  function trimLogState() {
    if (logState.logs.length > LOGS_LIMIT) {
      logState.logs.splice(0, logState.logs.length - LOGS_LIMIT);
    }
    if (logState.lines.length > LOG_LINES_LIMIT) {
      logState.lines.splice(0, logState.lines.length - LOG_LINES_LIMIT);
    }
  }

  async function appendLog(level, message, data) {
    const entry = {
      at: new Date().toISOString(),
      level: String(level || "info"),
      message: String(message || ""),
      data: null
    };

    if (data !== undefined) {
      entry.data = cloneLogData(data);
    }

    logWriteQueue = logWriteQueue
      .catch(() => {})
      .then(async () => {
        try {
          await ensureLogStateLoaded();
          logState.logs.push(entry);
          logState.lines.push(buildFlatLogLine(entry));
          trimLogState();

          await chrome.storage.local.set({
            [LOGS_STORAGE]: logState.logs,
            [LOG_LINES_STORAGE]: logState.lines,
            lastLogLine: logState.lines[logState.lines.length - 1] || "",
            lastLogAt: entry.at
          });
        } catch (_) {
          // Ignore storage errors for logs.
        }
      });

    await logWriteQueue;
  }

  async function saveLastError(message) {
    await chrome.storage.local.set({
      lastError: String(message || ""),
      lastErrorAt: new Date().toISOString()
    });
    await appendLog("error", "lastError updated", { message: String(message || "") });
  }

  async function setUserStatus(status, message, extra = {}) {
    const payload = {
      syncStatus: String(status || ""),
      syncStatusMessage: String(message || ""),
      syncStatusAt: new Date().toISOString(),
      ...extra
    };

    await chrome.storage.local.set(payload);
  }

  function notify(message) {
    try {
      chrome.notifications.create(
        {
          type: "basic",
          iconUrl: NOTIFY_ICON,
          title: "MyWhoosh -> Garmin",
          message
        },
        () => {
          // Avoid unhandled errors from notifications API on some Chrome setups.
          void chrome.runtime.lastError;
        }
      );
    } catch (_) {
      // Notification errors are non-fatal for sync flow.
    }
  }

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

  function fitKey(url) {
    try {
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname || "").toLowerCase();
      if (path) {
        return path;
      }
    } catch (_) {
      // Ignore and use fallback.
    }

    const noQuery = String(url || "").split("?")[0].trim().toLowerCase();
    return noQuery || String(url || "").trim().toLowerCase();
  }

  function activityKey(activity) {
    const id =
      activity?.activityFileId ??
      activity?.fileId ??
      activity?.activity_file_id ??
      activity?.id ??
      null;

    if (id !== null && id !== undefined && String(id).trim() !== "") {
      return `activity:${String(id).trim()}`;
    }

    const url = activity?.downloadUrl || activity?.url || "";
    return `url:${fitKey(url)}`;
  }

  function inferFilename(url, contentDisposition, index) {
    if (contentDisposition) {
      const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utfMatch?.[1]) {
        try {
          return decodeURIComponent(utfMatch[1]);
        } catch (_) {
          return utfMatch[1];
        }
      }
      const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
      if (plainMatch?.[1]) {
        return plainMatch[1];
      }
    }

    try {
      const parsed = new URL(url);
      const name = parsed.pathname.split("/").pop();
      if (name) {
        return decodeURIComponent(name);
      }
    } catch (_) {
      // Ignore and use fallback.
    }

    return `mywhoosh_activity_${Date.now()}_${index}.fit`;
  }

  function looksLikeDuplicate(status, bodyText) {
    const text = (bodyText || "").toLowerCase();
    return (
      status === 409 ||
      text.includes("duplicate") ||
      text.includes("already exists") ||
      text.includes("already uploaded")
    );
  }

  function seemsLikeAuthHtml(responseUrl, contentType, bodyText) {
    const url = String(responseUrl || "").toLowerCase();
    const ctype = String(contentType || "").toLowerCase();
    const text = String(bodyText || "").toLowerCase();

    if (url.includes("/signin")) {
      return true;
    }

    if (ctype.includes("text/html")) {
      return true;
    }

    if (text.includes("<html") && (text.includes("signin") || text.includes("garmin account"))) {
      return true;
    }

    return false;
  }

  function isGarminSignInUrl(url) {
    const text = String(url || "").toLowerCase();
    return text.includes("/signin") || text.includes("sso.garmin.com/portal/sso");
  }

  function isGarminAuthRedirectResponse(responseUrl) {
    const text = String(responseUrl || "").toLowerCase();
    return text.includes("/signin") || text.includes("sso.garmin.com/portal/sso");
  }

  function hasUploadFailures(bodyObj) {
    const direct = bodyObj?.failures;
    const detailed = bodyObj?.detailedImportResult?.failures;

    if (Array.isArray(direct) && direct.length > 0) {
      return true;
    }

    if (Array.isArray(detailed) && detailed.length > 0) {
      return true;
    }

    if (bodyObj && bodyObj.success === false) {
      return true;
    }

    return false;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getProcessedKeysMap() {
    const data = await chrome.storage.local.get(PROCESSED_KEYS_STORAGE);
    return data?.[PROCESSED_KEYS_STORAGE] || {};
  }

  async function setProcessedKeysMap(map) {
    await chrome.storage.local.set({ [PROCESSED_KEYS_STORAGE]: map });
  }

  function resetRuntimeCaches() {
    logState.loaded = false;
    logState.logs = [];
    logState.lines = [];
    logWriteQueue = Promise.resolve();
  }

  async function ensureStrictStateMigration() {
    const state = await chrome.storage.local.get([
      SYNC_STATE_VERSION_STORAGE,
      PROCESSED_KEYS_STORAGE
    ]);
    const version = state?.[SYNC_STATE_VERSION_STORAGE];

    if (version === SYNC_STATE_VERSION) {
      return { migrated: false, clearedKeys: 0 };
    }

    const existing = state?.[PROCESSED_KEYS_STORAGE] || {};
    const clearedKeys = Object.keys(existing).length;

    await chrome.storage.local.set({
      [PROCESSED_KEYS_STORAGE]: {},
      [SYNC_STATE_VERSION_STORAGE]: SYNC_STATE_VERSION,
      strictStateMigratedAt: new Date().toISOString()
    });

    await appendLog("warn", "Strict state migration applied", {
      fromVersion: version ?? null,
      toVersion: SYNC_STATE_VERSION,
      clearedKeys
    });

    return { migrated: true, clearedKeys };
  }

  function chromeTabsQuery(queryInfo) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tabs || []);
      });
    });
  }

  function chromeTabsCreate(createProperties) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create(createProperties, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function chromeTabsUpdate(tabId, updateProperties) {
    return new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab);
      });
    });
  }

  function chromeTabsGet(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab || null);
      });
    });
  }

  function chromeTabsRemove(tabIds) {
    return new Promise((resolve, reject) => {
      chrome.tabs.remove(tabIds, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function waitForTabComplete(tabId, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) {
          return;
        }
        if (changeInfo.status === "complete" || tab?.status === "complete") {
          finish();
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
      timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for tab ${tabId}`));
      }, timeoutMs);

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          fail(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (tab?.status === "complete") {
          finish();
        }
      });
    });
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function injectMyWhooshContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/mywhoosh-auth.js"]
    });
  }

  async function sendMessageToTabWithRetry(tabId, message) {
    try {
      return await sendMessageToTab(tabId, message);
    } catch (error) {
      const text = errorText(error).toLowerCase();
      if (!text.includes("receiving end does not exist")) {
        throw error;
      }

      await appendLog("warn", "Content script missing, injecting and retrying sendMessage", {
        tabId,
        messageType: message?.type || ""
      });
      await injectMyWhooshContentScript(tabId);
      return await sendMessageToTab(tabId, message);
    }
  }

  async function collectMyWhooshAuth(tabId) {
    return await sendMessageToTabWithRetry(tabId, { type: "COLLECT_MYWHOOSH_AUTH" });
  }

  function normalizeStoredMyWhooshAuth(auth) {
    const webToken = String(auth?.webToken || "").trim();
    if (!webToken) {
      return null;
    }

    return {
      webToken,
      pageUrl: String(auth?.pageUrl || "").trim(),
      capturedAt: String(auth?.capturedAt || new Date().toISOString())
    };
  }

  async function getStoredMyWhooshAuth() {
    const data = await chrome.storage.local.get(MYWHOOSH_AUTH_STORAGE);
    return normalizeStoredMyWhooshAuth(data?.[MYWHOOSH_AUTH_STORAGE]);
  }

  async function setStoredMyWhooshAuth(auth, source = "tab") {
    const normalized = normalizeStoredMyWhooshAuth({
      ...auth,
      capturedAt: new Date().toISOString()
    });
    if (!normalized) {
      return null;
    }

    await chrome.storage.local.set({
      [MYWHOOSH_AUTH_STORAGE]: normalized
    });
    await appendLog("info", "Stored MyWhoosh auth token", {
      source,
      pageUrl: normalized.pageUrl,
      length: normalized.webToken.length
    });
    return normalized;
  }

  async function clearStoredMyWhooshAuth(reason = "") {
    await chrome.storage.local.remove(MYWHOOSH_AUTH_STORAGE);
    if (reason) {
      await appendLog("warn", "Cleared stored MyWhoosh auth token", {
        reason
      });
    }
  }

  Object.assign(MWG, {
    EXTENSION_VERSION,
    GARMIN_API_AUTH_MAX_AGE_MS,
    GARMIN_AUTH_POLL_INTERVAL_MS,
    GARMIN_AUTH_WAIT_TIMEOUT_MS,
    GARMIN_CONNECTAPI_UPLOAD_URL,
    GARMIN_OAUTH_CONSUMER_URL,
    GARMIN_OAUTH_USER_AGENT,
    GARMIN_SSO_BASE_URL,
    GARMIN_SSO_EMBED_URL,
    GARMIN_SSO_SIGNIN_URL,
    GARMIN_UPLOAD_STRATEGY,
    LOGS_STORAGE,
    LOG_LINES_STORAGE,
    MYWHOOSH_AUTH_STORAGE,
    MYWHOOSH_ACTIVITIES_URL,
    MYWHOOSH_APP_ENTRY_URL,
    MYWHOOSH_AES_KEY,
    MYWHOOSH_DEFAULT_SORT,
    MYWHOOSH_DEFAULT_TYPE,
    MYWHOOSH_DOWNLOAD_URL,
    MYWHOOSH_MAX_PAGES,
    PROCESSED_KEYS_STORAGE,
    SYNC_STATE_VERSION,
    SYNC_STATE_VERSION_STORAGE,
    activityKey,
    appendLog,
    chromeTabsCreate,
    chromeTabsGet,
    chromeTabsQuery,
    chromeTabsRemove,
    chromeTabsUpdate,
    clearStoredMyWhooshAuth,
    collectMyWhooshAuth,
    ensureStrictStateMigration,
    errorText,
    fitKey,
    getStoredMyWhooshAuth,
    getProcessedKeysMap,
    hasUploadFailures,
    inferFilename,
    isGarminAuthRedirectResponse,
    isGarminSignInUrl,
    isMyWhooshUrl,
    looksLikeDuplicate,
    notify,
    resetRuntimeCaches,
    saveLastError,
    seemsLikeAuthHtml,
    setStoredMyWhooshAuth,
    setProcessedKeysMap,
    setUserStatus,
    wait,
    waitForTabComplete
  });
})();
