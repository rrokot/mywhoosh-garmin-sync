importScripts("lib/crypto-js.min.js");

const GARMIN_MODERN_IMPORT_URL = "https://connect.garmin.com/modern/import-data";
const GARMIN_SIGNIN_URL =
  "https://connect.garmin.com/signin/?service=" + encodeURIComponent(GARMIN_MODERN_IMPORT_URL);
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
const MYWHOOSH_AES_KEY = "D9436E508087E863";
const MYWHOOSH_DEFAULT_TYPE = "";
const MYWHOOSH_DEFAULT_SORT = "DESC";
const MYWHOOSH_MAX_PAGES = 100;
const LOGS_STORAGE = "syncLogs";
const LOGS_LIMIT = 600;
const LOG_LINES_STORAGE = "syncLogLines";
const LOG_LINES_LIMIT = 1200;
const LOG_LINE_PREFIX = "MWGLOG";
const LOG_LINE_DATA_MAX_LEN = 700;
const SYNC_STATE_VERSION_STORAGE = "syncStateVersion";
const SYNC_STATE_VERSION = 2;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let garminCsrfTokenCache = null;
let garminApiAuthHeaderCache = null;
let garminApiAuthHeaderCapturedAt = 0;
let garminApiAuthHeaderLogAt = 0;
let garminOauthConsumerCache = null;

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

  try {
    const existingData = await chrome.storage.local.get([LOGS_STORAGE, LOG_LINES_STORAGE]);
    const logs = Array.isArray(existingData?.[LOGS_STORAGE]) ? existingData[LOGS_STORAGE] : [];
    const lines = Array.isArray(existingData?.[LOG_LINES_STORAGE]) ? existingData[LOG_LINES_STORAGE] : [];
    logs.push(entry);
    lines.push(buildFlatLogLine(entry));

    if (logs.length > LOGS_LIMIT) {
      logs.splice(0, logs.length - LOGS_LIMIT);
    }
    if (lines.length > LOG_LINES_LIMIT) {
      lines.splice(0, lines.length - LOG_LINES_LIMIT);
    }

    await chrome.storage.local.set({
      [LOGS_STORAGE]: logs,
      [LOG_LINES_STORAGE]: lines,
      lastLogLine: lines[lines.length - 1] || "",
      lastLogAt: entry.at
    });
  } catch (_) {
    // Ignore storage errors for logs.
  }
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

function isGarminBearer(value) {
  return /^Bearer\s+.+/i.test(String(value || "").trim());
}

function getFreshGarminApiAuthorization() {
  if (!isGarminBearer(garminApiAuthHeaderCache)) {
    return null;
  }
  if (Date.now() - garminApiAuthHeaderCapturedAt > GARMIN_API_AUTH_MAX_AGE_MS) {
    return null;
  }
  return String(garminApiAuthHeaderCache);
}

function setGarminApiAuthorizationHeader(value, source = "oauth2") {
  const normalized = String(value || "").trim();
  if (!isGarminBearer(normalized)) {
    return;
  }

  const previous = String(garminApiAuthHeaderCache || "");
  garminApiAuthHeaderCache = normalized;
  garminApiAuthHeaderCapturedAt = Date.now();

  const shouldLog =
    previous !== normalized || Date.now() - garminApiAuthHeaderLogAt > 60 * 1000;
  if (shouldLog) {
    garminApiAuthHeaderLogAt = Date.now();
    appendLog("info", "Captured Garmin API bearer token", {
      source,
      length: normalized.length
    }).catch(() => {});
  }
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value ?? "")).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function generateOauthNonce(bytesCount = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildGarminOAuth1AuthorizationHeader(config) {
  const {
    method,
    url,
    consumerKey,
    consumerSecret,
    token = "",
    tokenSecret = "",
    bodyParams = {}
  } = config || {};

  if (!method || !url || !consumerKey || !consumerSecret) {
    throw new Error("OAuth1 header config is incomplete");
  }

  const parsedUrl = new URL(url);
  const oauthParams = {
    oauth_consumer_key: String(consumerKey),
    oauth_nonce: generateOauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0"
  };
  if (token) {
    oauthParams.oauth_token = String(token);
  }

  const signaturePairs = [];
  parsedUrl.searchParams.forEach((value, key) => {
    signaturePairs.push([String(key), String(value)]);
  });
  Object.entries(bodyParams || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    signaturePairs.push([String(key), String(value)]);
  });
  Object.entries(oauthParams).forEach(([key, value]) => {
    signaturePairs.push([String(key), String(value)]);
  });
  signaturePairs.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    }
    return a[0] < b[0] ? -1 : 1;
  });

  const normalizedParams = signaturePairs
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  const baseString = [
    String(method).toUpperCase(),
    encodeRfc3986(baseUrl),
    encodeRfc3986(normalizedParams)
  ].join("&");
  const signingKey = `${encodeRfc3986(consumerSecret)}&${encodeRfc3986(tokenSecret || "")}`;
  const signature = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA1(baseString, signingKey));

  const headerParams = {
    ...oauthParams,
    oauth_signature: signature
  };
  const header = `OAuth ${Object.entries(headerParams)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${encodeRfc3986(key)}="${encodeRfc3986(value)}"`)
    .join(", ")}`;
  return header;
}

function parseHtmlTitle(text) {
  const match = String(text || "").match(/<title>([^<]*)<\/title>/i);
  return match?.[1] ? match[1].trim() : "";
}

function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(String(text || ""));
  } catch (_) {
    return String(text || "");
  }
}

function extractGarminSsoTicket(responseUrl, bodyText) {
  try {
    const parsed = new URL(String(responseUrl || ""));
    const fromUrl = parsed.searchParams.get("ticket");
    if (fromUrl) {
      return fromUrl;
    }
  } catch (_) {
    // Ignore invalid URL and continue fallback parsing.
  }

  const body = String(bodyText || "");
  const specific = body.match(/embed\?ticket=([^"'&<\s]+)/i);
  if (specific?.[1]) {
    return safeDecodeURIComponent(String(specific[1]).replace(/&amp;/g, "&"));
  }

  const generic = body.match(/[?&]ticket=([^"'&<\s]+)/i);
  if (generic?.[1]) {
    return safeDecodeURIComponent(String(generic[1]).replace(/&amp;/g, "&"));
  }

  return null;
}

function buildGarminSsoEmbedParams() {
  return new URLSearchParams({
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: GARMIN_SSO_BASE_URL
  });
}

function buildGarminSsoSignInParams() {
  return new URLSearchParams({
    id: "gauth-widget",
    embedWidget: "true",
    gauthHost: GARMIN_SSO_EMBED_URL,
    service: GARMIN_SSO_EMBED_URL,
    source: GARMIN_SSO_EMBED_URL,
    redirectAfterAccountLoginUrl: GARMIN_SSO_EMBED_URL,
    redirectAfterAccountCreationUrl: GARMIN_SSO_EMBED_URL
  });
}

async function fetchGarminSsoTicketFromSession() {
  const embedUrl = `${GARMIN_SSO_EMBED_URL}?${buildGarminSsoEmbedParams().toString()}`;
  await fetch(embedUrl, {
    method: "GET",
    credentials: "include"
  });

  const signInUrl = `${GARMIN_SSO_SIGNIN_URL}?${buildGarminSsoSignInParams().toString()}`;
  const response = await fetch(signInUrl, {
    method: "GET",
    credentials: "include"
  });
  const bodyText = await response.text().catch(() => "");
  const title = parseHtmlTitle(bodyText);
  const ticket = extractGarminSsoTicket(response.url, bodyText);
  const loginLikePage =
    isGarminSignInUrl(response.url) &&
    (String(title || "").toLowerCase().includes("sign in") ||
      String(bodyText || "").toLowerCase().includes("name=\"username\""));

  await appendLog("info", "Garmin SSO ticket probe", {
    status: response.status,
    responseUrl: response.url,
    title,
    ticketFound: Boolean(ticket)
  });

  if (ticket) {
    return {
      ticket,
      status: response.status,
      responseUrl: response.url,
      title
    };
  }
  if (loginLikePage) {
    throw new Error("Garmin SSO session is not authenticated");
  }
  throw new Error("Garmin SSO ticket not found");
}

async function getGarminOauthConsumer() {
  if (
    garminOauthConsumerCache &&
    typeof garminOauthConsumerCache.consumer_key === "string" &&
    typeof garminOauthConsumerCache.consumer_secret === "string"
  ) {
    return garminOauthConsumerCache;
  }

  const response = await fetch(GARMIN_OAUTH_CONSUMER_URL, {
    method: "GET",
    credentials: "omit"
  });
  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `Could not load Garmin OAuth consumer: HTTP ${response.status} (${bodyText.slice(0, 120)})`
    );
  }

  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed.consumer_key !== "string" ||
    typeof parsed.consumer_secret !== "string"
  ) {
    throw new Error("Garmin OAuth consumer payload is invalid");
  }

  garminOauthConsumerCache = parsed;
  return parsed;
}

async function fetchGarminOAuth1Token(ticket) {
  const consumer = await getGarminOauthConsumer();
  const preauthUrl =
    "https://connectapi.garmin.com/oauth-service/oauth/preauthorized" +
    `?ticket=${encodeURIComponent(ticket)}` +
    `&login-url=${encodeURIComponent(GARMIN_SSO_EMBED_URL)}` +
    "&accepts-mfa-tokens=true";
  const authHeader = buildGarminOAuth1AuthorizationHeader({
    method: "GET",
    url: preauthUrl,
    consumerKey: consumer.consumer_key,
    consumerSecret: consumer.consumer_secret
  });

  const response = await fetch(preauthUrl, {
    method: "GET",
    credentials: "omit",
    headers: {
      Authorization: authHeader,
      "User-Agent": GARMIN_OAUTH_USER_AGENT
    }
  });
  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `Garmin OAuth1 preauthorized failed: HTTP ${response.status} (${bodyText.slice(0, 180)})`
    );
  }

  const params = new URLSearchParams(bodyText);
  const oauthToken = params.get("oauth_token");
  const oauthTokenSecret = params.get("oauth_token_secret");
  const mfaToken = params.get("mfa_token");
  if (!oauthToken || !oauthTokenSecret) {
    throw new Error("Garmin OAuth1 token payload is missing token fields");
  }

  return {
    oauth_token: oauthToken,
    oauth_token_secret: oauthTokenSecret,
    mfa_token: mfaToken || ""
  };
}

async function fetchGarminOAuth2Token(oauth1Token) {
  const consumer = await getGarminOauthConsumer();
  const exchangeUrl = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
  const bodyParams = {};
  if (oauth1Token?.mfa_token) {
    bodyParams.mfa_token = String(oauth1Token.mfa_token);
  }
  const bodyString = new URLSearchParams(bodyParams).toString();
  const authHeader = buildGarminOAuth1AuthorizationHeader({
    method: "POST",
    url: exchangeUrl,
    consumerKey: consumer.consumer_key,
    consumerSecret: consumer.consumer_secret,
    token: oauth1Token?.oauth_token || "",
    tokenSecret: oauth1Token?.oauth_token_secret || "",
    bodyParams
  });

  const response = await fetch(exchangeUrl, {
    method: "POST",
    credentials: "omit",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GARMIN_OAUTH_USER_AGENT
    },
    body: bodyString
  });
  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `Garmin OAuth2 exchange failed: HTTP ${response.status} (${bodyText.slice(0, 180)})`
    );
  }

  let token = null;
  try {
    token = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    token = null;
  }
  if (!token || typeof token.access_token !== "string") {
    throw new Error("Garmin OAuth2 exchange returned invalid JSON token");
  }

  const tokenTypeRaw = String(token.token_type || "Bearer").trim();
  const tokenType =
    tokenTypeRaw.length > 0
      ? `${tokenTypeRaw.slice(0, 1).toUpperCase()}${tokenTypeRaw.slice(1)}`
      : "Bearer";
  const authorization = `${tokenType} ${token.access_token}`;
  setGarminApiAuthorizationHeader(authorization, "oauth2-exchange");

  return {
    authorization,
    expiresIn: Number(token.expires_in || 0),
    tokenType,
    token
  };
}

function extractGarminCsrfToken(text) {
  const match = String(text || "").match(
    /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i
  );
  return match?.[1] ? match[1].trim() : null;
}

async function fetchGarminImportPage() {
  const response = await fetch(GARMIN_MODERN_IMPORT_URL, {
    method: "GET",
    credentials: "include"
  });
  const bodyText = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") || "";
  const token = extractGarminCsrfToken(bodyText);
  const authRequired =
    isGarminSignInUrl(response.url) || (seemsLikeAuthHtml(response.url, contentType, bodyText) && !token);

  return {
    status: response.status,
    responseUrl: response.url,
    contentType,
    bodyText,
    token,
    authRequired
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGarminAuthState(forceRefresh = false, silent = false) {
  if (!forceRefresh && garminCsrfTokenCache) {
    return {
      authenticated: true,
      token: garminCsrfTokenCache,
      reason: "token-cache"
    };
  }

  const page = await fetchGarminImportPage();
  const token = page.token;
  if (token) {
    garminCsrfTokenCache = token;
  }

  const authenticated = Boolean(token) && !page.authRequired;
  const state = {
    authenticated,
    token: token || null,
    status: page.status,
    responseUrl: page.responseUrl,
    contentType: page.contentType
  };

  if (!authenticated && !silent) {
    await appendLog("warn", "Garmin session is not authenticated", {
      status: page.status,
      responseUrl: page.responseUrl,
      contentType: page.contentType,
      sample: page.bodyText.slice(0, 220)
    });
  }

  return state;
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

function waitForTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for Garmin import tab to load"));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === "complete") {
        finish();
      }
    });
  });
}

async function ensureGarminImportTab(active = false, useSignInUrl = false) {
  const targetUrl = useSignInUrl ? GARMIN_SIGNIN_URL : GARMIN_MODERN_IMPORT_URL;
  const tabs = await chromeTabsQuery({ url: ["https://connect.garmin.com/*"] });
  const existing = tabs.find((tab) => typeof tab?.url === "string" && tab.url.includes("/modern/import-data"));

  let tab;
  if (existing?.id) {
    tab = await chromeTabsUpdate(existing.id, { url: targetUrl, active });
  } else {
    tab = await chromeTabsCreate({ url: targetUrl, active });
  }

  if (!tab?.id) {
    throw new Error("Could not open Garmin import tab");
  }

  await waitForTabComplete(tab.id, 90000);
  return tab.id;
}

async function ensureGarminAuthenticatedInteractive() {
  const state = await getGarminAuthState(false, true);
  if (state.authenticated) {
    await appendLog("info", "Garmin auth verified", {
      source: state.reason || "import-page-check"
    });
    return;
  }

  await appendLog("warn", "Garmin login required, opening sign-in tab", {
    status: state.status ?? null,
    responseUrl: state.responseUrl || ""
  });
  notify("Garmin login required. Complete sign-in in opened tab.");

  try {
    await ensureGarminImportTab(true, true);
  } catch (error) {
    throw new Error(`Could not open Garmin sign-in tab: ${errorText(error)}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < GARMIN_AUTH_WAIT_TIMEOUT_MS) {
    await wait(GARMIN_AUTH_POLL_INTERVAL_MS);
    const probe = await getGarminAuthState(true, true);
    if (probe.authenticated) {
      await appendLog("info", "Garmin auth confirmed after interactive sign-in", {
        waitedMs: Date.now() - startedAt
      });
      notify("Garmin login detected. Continuing sync...");
      return;
    }
  }

  throw new Error("Garmin login not completed in time. Sign in on Garmin tab and retry.");
}

async function ensureGarminApiAuthorization(forceRecapture = false) {
  if (!forceRecapture) {
    const cached = getFreshGarminApiAuthorization();
    if (cached) {
      return {
        authorization: cached,
        source: "cache"
      };
    }
  }

  const tryIssueAuthorization = async (source) => {
    const ticketProbe = await fetchGarminSsoTicketFromSession();
    const oauth1Token = await fetchGarminOAuth1Token(ticketProbe.ticket);
    const oauth2Token = await fetchGarminOAuth2Token(oauth1Token);
    await appendLog("info", "Garmin OAuth2 authorization issued", {
      source,
      ticketUrl: ticketProbe.responseUrl,
      expiresIn: oauth2Token.expiresIn || 0
    });
    return {
      authorization: oauth2Token.authorization,
      source
    };
  };

  try {
    return await tryIssueAuthorization("oauth2-from-sso-session");
  } catch (firstError) {
    await appendLog("warn", "Garmin OAuth2 issue from active session failed", {
      error: errorText(firstError)
    });

    const text = errorText(firstError).toLowerCase();
    const isAuthIssue =
      text.includes("not authenticated") ||
      text.includes("ticket not found") ||
      text.includes("signin");
    if (!isAuthIssue) {
      throw firstError;
    }

    await appendLog("warn", "Garmin login required for OAuth2, opening sign-in tab");
    await ensureGarminAuthenticatedInteractive();
    try {
      return await tryIssueAuthorization("oauth2-after-interactive-signin");
    } catch (secondError) {
      await appendLog("error", "Garmin OAuth2 issue failed after interactive sign-in", {
        error: errorText(secondError)
      });
      throw secondError;
    }
  }
}

async function uploadViaGarminConnectApi(filename, blob, authorization) {
  const formData = new FormData();
  formData.append("file", blob, filename);

  const response = await fetch(GARMIN_CONNECTAPI_UPLOAD_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: authorization
    },
    body: formData
  });

  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text().catch(() => "");

  return {
    ok: true,
    response: {
      transport: "connectapi",
      requestUrl: GARMIN_CONNECTAPI_UPLOAD_URL,
      url: String(response.url || GARMIN_CONNECTAPI_UPLOAD_URL),
      status: Number(response.status || 0),
      contentType,
      bodyText
    }
  };
}

async function downloadFit(url, index) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const filename = inferFilename(
    url,
    response.headers.get("content-disposition"),
    index
  );
  const blob = await response.blob();

  if (!filename.toLowerCase().endsWith(".fit")) {
    throw new Error(`Not a FIT file: ${filename}`);
  }

  return { filename, blob };
}

async function uploadToGarmin(filename, blob) {
  const totalAttempts = 2;
  await appendLog("info", "Garmin upload started", {
    filename,
    totalAttempts,
    strategies: [GARMIN_UPLOAD_STRATEGY]
  });

  let lastError = "Garmin upload failed";
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const forceRecapture = attempt > 1;
    const auth = await ensureGarminApiAuthorization(forceRecapture);
    const payload = await uploadViaGarminConnectApi(filename, blob, auth.authorization);

    if (!payload || !payload.ok) {
      lastError = `Garmin upload failed: ${payload?.error || "no API response"}`;
      continue;
    }

    const response = payload.response || {};
    const status = Number(response.status || 0);
    const endpoint = String(response.requestUrl || response.url || GARMIN_CONNECTAPI_UPLOAD_URL);
    const responseUrl = String(response.url || response.requestUrl || "");
    const contentType = String(response.contentType || "");
    const bodyText = String(response.bodyText || "");
    const detail = `HTTP ${status} @ ${endpoint}`;

    let bodyObj = null;
    try {
      bodyObj = bodyText ? JSON.parse(bodyText) : null;
    } catch (_) {
      bodyObj = null;
    }

    await appendLog("info", "Garmin upload attempt", {
      filename,
      attempt,
      totalAttempts,
      strategy: GARMIN_UPLOAD_STRATEGY,
      endpoint,
      status,
      responseUrl,
      contentType,
      authSource: auth.source,
      sample: bodyText.slice(0, 240)
    });

    if (isGarminAuthRedirectResponse(responseUrl)) {
      lastError = "Garmin upload failed: Garmin session is not authenticated";
      if (attempt < totalAttempts) {
        await appendLog("warn", "Garmin upload blocked by auth page, recapturing bearer", {
          filename,
          attempt,
          totalAttempts,
          responseUrl
        });
        continue;
      }
      throw new Error(lastError);
    }

    if (String(contentType || "").toLowerCase().includes("text/html")) {
      lastError = "Garmin upload failed: endpoint returned HTML instead of upload API response";
      if (attempt < totalAttempts) {
        await appendLog("warn", "Garmin upload returned HTML, recapturing bearer", {
          filename,
          attempt,
          totalAttempts,
          responseUrl
        });
        continue;
      }
      throw new Error(lastError);
    }

    const failureText = bodyObj ? JSON.stringify(bodyObj) : bodyText;
    if (looksLikeDuplicate(status, failureText)) {
      return { status: "duplicate", detail };
    }

    if (status === 401 || status === 403) {
      lastError = `Garmin upload failed: ${status} ${endpoint}`;
      if (attempt < totalAttempts) {
        await appendLog("warn", "Garmin API auth rejected, recapturing bearer", {
          filename,
          attempt,
          totalAttempts,
          status,
          endpoint
        });
        continue;
      }
    }

    if (status >= 200 && status < 300) {
      if (hasUploadFailures(bodyObj)) {
        if (looksLikeDuplicate(status, failureText)) {
          return { status: "duplicate", detail };
        }
        throw new Error(`Garmin upload failed: upload API returned failures (${detail})`);
      }
      return { status: "uploaded", detail };
    }

    lastError = `Garmin upload failed: #${attempt}/${totalAttempts} ${status} ${endpoint}`;
    if (attempt < totalAttempts) {
      continue;
    }
  }

  await appendLog("error", "Garmin API upload failed", {
    filename,
    attempts: totalAttempts,
    chain: lastError
  });
  throw new Error(lastError);
}

async function uploadOne(url, index) {
  const { filename, blob } = await downloadFit(url, index);
  const uploadResult = await uploadToGarmin(filename, blob);
  return { filename, ...uploadResult };
}

async function getProcessedKeysMap() {
  const data = await chrome.storage.local.get(PROCESSED_KEYS_STORAGE);
  return data?.[PROCESSED_KEYS_STORAGE] || {};
}

async function setProcessedKeysMap(map) {
  await chrome.storage.local.set({ [PROCESSED_KEYS_STORAGE]: map });
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

function normalizeActivitiesPayload(data) {
  if (Array.isArray(data)) {
    return { results: data, totalPages: 1 };
  }

  if (Array.isArray(data?.results)) {
    return { results: data.results, totalPages: Number(data.totalPages || data.lastPage || 1) || 1 };
  }

  if (Array.isArray(data?.data?.results)) {
    return {
      results: data.data.results,
      totalPages: Number(data.data.totalPages || data.data.lastPage || 1) || 1
    };
  }

  if (Array.isArray(data?.data)) {
    return { results: data.data, totalPages: Number(data.totalPages || data.lastPage || 1) || 1 };
  }

  return { results: [], totalPages: 1 };
}

function resolveDownloadUrl(data) {
  if (typeof data === "string" && data.startsWith("http")) {
    return data;
  }

  const candidates = [
    data?.data,
    data?.url,
    data?.downloadUrl,
    data?.fileUrl,
    data?.data?.url,
    data?.data?.downloadUrl,
    data?.data?.fileUrl
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("http")) {
      return candidate;
    }
  }

  return null;
}

function extractFileId(activity) {
  const candidates = [
    activity?.activityFileId,
    activity?.fileId,
    activity?.activity_file_id,
    activity?.id
  ];

  for (const id of candidates) {
    if (id !== null && id !== undefined && String(id).trim() !== "") {
      return String(id).trim();
    }
  }

  return null;
}

function uniqueActivities(activities) {
  const map = new Map();

  for (const activity of activities || []) {
    const key = activityKey(activity);
    if (!map.has(key)) {
      map.set(key, activity);
    }
  }

  return Array.from(map.values());
}

function encryptMyWhooshPayload(payload) {
  if (typeof CryptoJS === "undefined") {
    throw new Error("CryptoJS is not loaded in extension service worker.");
  }

  return CryptoJS.AES.encrypt(JSON.stringify(payload), MYWHOOSH_AES_KEY).toString();
}

async function requestMyWhooshApi(url, token, payload) {
  const encryptedPayload = encryptMyWhooshPayload(payload);

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(encryptedPayload)
  });

  const rawText = await response.text();
  let data;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    data = rawText;
  }

  if (!response.ok) {
    const detail = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
    await appendLog("error", "MyWhoosh API error", {
      url,
      status: response.status,
      detail
    });
    throw new Error(`MyWhoosh API failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
  }

  return data;
}

async function fetchAllMyWhooshActivities(token) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MYWHOOSH_MAX_PAGES) {
    const payload = {
      type: MYWHOOSH_DEFAULT_TYPE,
      page,
      sortDate: MYWHOOSH_DEFAULT_SORT
    };

    const data = await requestMyWhooshApi(MYWHOOSH_ACTIVITIES_URL, token, payload);
    const normalized = normalizeActivitiesPayload(data);
    all.push(...normalized.results);
    await appendLog("info", "MyWhoosh activities page fetched", {
      page,
      fetched: normalized.results.length,
      totalPages: normalized.totalPages || 1
    });

    totalPages = Math.max(totalPages, normalized.totalPages || 1);
    page += 1;
  }

  const unique = uniqueActivities(all);
  await appendLog("info", "MyWhoosh activities fetch complete", {
    rawCount: all.length,
    uniqueCount: unique.length,
    pagesRead: page - 1
  });
  return unique;
}

async function fetchMyWhooshDownloadUrl(token, fileId) {
  const data = await requestMyWhooshApi(MYWHOOSH_DOWNLOAD_URL, token, { fileId });
  const url = resolveDownloadUrl(data);

  if (!url) {
    throw new Error(`Download URL not found for fileId ${fileId}`);
  }

  return url;
}

async function handleUploadNewMyWhooshActivities(token, onProgress = null, options = {}) {
  await appendLog("info", "MyWhoosh sync started");
  const onlyLatest = Boolean(options?.onlyLatest);
  const processed = await getProcessedKeysMap();
  const activities = await fetchAllMyWhooshActivities(token);
  const newActivities = activities.filter((activity) => !processed[activityKey(activity)]);
  const selectedActivities = onlyLatest && newActivities.length > 0 ? [newActivities[0]] : newActivities;
  if (selectedActivities.length > 0) {
    await ensureGarminAuthenticatedInteractive();
  }

  const summary = {
    mode: "mywhoosh_api",
    scope: onlyLatest ? "latest" : "new",
    totalFound: activities.length,
    totalNew: selectedActivities.length,
    skipped: activities.length - selectedActivities.length,
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
    lastUploadAt: new Date().toISOString()
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
    files: ["content-mywhoosh.js"]
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

async function showCopyableText(tabId, message) {
  if (!tabId) {
    return;
  }

  try {
    await sendMessageToTabWithRetry(tabId, {
      type: "SHOW_COPYABLE_TEXT",
      message: String(message || "")
    });
  } catch (error) {
    await appendLog("warn", "Could not show copyable text in tab", {
      tabId,
      error: errorText(error)
    });
  }
}

async function runOneClickSync(tab, mode = "new") {
  const normalizedMode = mode === "latest" ? "latest" : "new";
  await appendLog("info", "Extension icon clicked", {
    tabUrl: tab?.url || "",
    mode: normalizedMode
  });
  await setUserStatus("started", `Started (${normalizedMode})`, {
    syncInProgress: true
  });

  if (!tab?.id || !isMyWhooshUrl(tab.url)) {
    const message = "Open MyWhoosh page, then click extension icon again.";
    notify(message);
    await showCopyableText(tab?.id, message);
    await appendLog("warn", "Sync aborted: wrong tab", { tabUrl: tab?.url || "" });
    await setUserStatus("aborted", message, {
      syncInProgress: false,
      lastUserMessage: message,
      lastUserMessageAt: new Date().toISOString()
    });
    return;
  }

  const migration = await ensureStrictStateMigration();
  let migrationSuffix = "";
  if (migration.migrated && migration.clearedKeys > 0) {
    migrationSuffix = ` | strict-state reset: ${migration.clearedKeys}`;
  }

  notify(
    normalizedMode === "latest"
      ? "Sync started (latest): checking MyWhoosh auth..."
      : "Sync started: checking MyWhoosh auth..."
  );
  await setUserStatus("running", `Checking MyWhoosh auth (${normalizedMode})`, {
    syncInProgress: true
  });

  const authResponse = await collectMyWhooshAuth(tab.id);
  if (!authResponse?.ok) {
    await appendLog("error", "Could not read MyWhoosh auth", authResponse || null);
    throw new Error(authResponse?.error || "Could not read MyWhoosh auth from tab");
  }

  const token = authResponse.webToken;
  if (!token) {
    const message = "MyWhoosh token not found. Log in on MyWhoosh in this tab/profile first.";
    notify(message);
    await showCopyableText(tab?.id, message);
    await appendLog("warn", "Sync aborted: missing webToken");
    await setUserStatus("aborted", message, {
      syncInProgress: false,
      lastUserMessage: message,
      lastUserMessageAt: new Date().toISOString()
    });
    return;
  }

  notify(
    normalizedMode === "latest"
      ? "Sync started (latest): loading MyWhoosh activities..."
      : "Sync started: loading MyWhoosh activities..."
  );
  let lastProgressNotifiedAt = 0;
  let lastProgressCurrent = -1;
  const onProgress = async (progress) => {
    const current = Number(progress?.current || 0);
    const total = Number(progress?.total || 0);
    const summary = progress?.summary || {};
    const phase = progress?.phase || "uploading";
    const now = Date.now();
    const shouldNotify =
      phase === "finished" ||
      current === 0 ||
      current === total ||
      current % 3 === 0 ||
      now - lastProgressNotifiedAt >= 12000;

    if (!shouldNotify || current === lastProgressCurrent) {
      return;
    }

    lastProgressCurrent = current;
    lastProgressNotifiedAt = now;

    const text =
      total <= 0
        ? `Sync (${normalizedMode}): no activities | Found: ${summary.totalFound || 0}, Skipped: ${summary.skipped || 0}`
        : `Sync (${normalizedMode}): ${current}/${total} | Uploaded: ${summary.uploaded || 0}, Duplicate: ${summary.duplicate || 0}, Failed: ${summary.failed || 0}`;

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
    await setUserStatus("running", text, {
      syncInProgress: true
    });
  };

  const summary = await handleUploadNewMyWhooshActivities(token, onProgress, {
    onlyLatest: normalizedMode === "latest"
  });
  const firstFailed = summary.items.find((item) => item.status === "failed");
  const failSuffix = firstFailed?.detail ? ` | first fail: ${firstFailed.detail}` : "";
  const modeSuffix = normalizedMode === "latest" ? " | mode: latest" : "";
  const message = `Uploaded: ${summary.uploaded}, Duplicate: ${summary.duplicate}, Failed: ${summary.failed}, Skipped: ${summary.skipped}${modeSuffix}${migrationSuffix}${failSuffix}`;
  notify(message);
  await showCopyableText(tab?.id, message);
  await setUserStatus("finished", message, {
    syncInProgress: false,
    lastUserMessage: message,
    lastUserMessageAt: new Date().toISOString()
  });
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
        const messageText = errorText(error);
        notify(`Error: ${messageText}`);
        saveLastError(messageText).catch(() => {});
        showCopyableText(tab?.id, `Error: ${messageText}`).catch(() => {});
        setUserStatus("error", `Error: ${messageText}`, {
          syncInProgress: false,
          lastUserMessage: `Error: ${messageText}`,
          lastUserMessageAt: new Date().toISOString()
        }).catch(() => {});
        appendLog("error", "Sync run failed", { message: messageText, tabUrl: tab?.url || "", mode }).catch(() => {});
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
    const message = errorText(error);
    notify(`Error: ${message}`);
    saveLastError(message).catch(() => {});
    showCopyableText(tab?.id, `Error: ${message}`).catch(() => {});
    setUserStatus("error", `Error: ${message}`, {
      syncInProgress: false,
      lastUserMessage: `Error: ${message}`,
      lastUserMessageAt: new Date().toISOString()
    }).catch(() => {});
    appendLog("error", "Sync run failed", { message, tabUrl: tab?.url || "" }).catch(() => {});
  });
});
