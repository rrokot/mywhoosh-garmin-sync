(() => {
  const MWG = globalThis.MWG;
  const {
    GARMIN_API_AUTH_MAX_AGE_MS,
    GARMIN_AUTH_POLL_INTERVAL_MS,
    GARMIN_AUTH_WAIT_TIMEOUT_MS,
    GARMIN_CONNECTAPI_UPLOAD_URL,
    GARMIN_MODERN_IMPORT_URL,
    GARMIN_OAUTH_CONSUMER_URL,
    GARMIN_OAUTH_USER_AGENT,
    GARMIN_SIGNIN_URL,
    GARMIN_SSO_BASE_URL,
    GARMIN_SSO_EMBED_URL,
    GARMIN_SSO_SIGNIN_URL,
    GARMIN_UPLOAD_STRATEGY,
    appendLog,
    chromeTabsCreate,
    chromeTabsQuery,
    chromeTabsUpdate,
    errorText,
    hasUploadFailures,
    inferFilename,
    isGarminAuthRedirectResponse,
    isGarminSignInUrl,
    looksLikeDuplicate,
    notify,
    seemsLikeAuthHtml,
    wait,
    waitForTabComplete
  } = MWG;

  const garminState = MWG.garminState || (MWG.garminState = {
    garminApiAuthHeaderCache: null,
    garminApiAuthHeaderCapturedAt: 0,
    garminApiAuthHeaderLogAt: 0,
    garminCsrfTokenCache: null,
    garminOauthConsumerCache: null
  });

  function isGarminBearer(value) {
    return /^Bearer\s+.+/i.test(String(value || "").trim());
  }

  function getFreshGarminApiAuthorization() {
    if (!isGarminBearer(garminState.garminApiAuthHeaderCache)) {
      return null;
    }
    if (Date.now() - garminState.garminApiAuthHeaderCapturedAt > GARMIN_API_AUTH_MAX_AGE_MS) {
      return null;
    }
    return String(garminState.garminApiAuthHeaderCache);
  }

  function setGarminApiAuthorizationHeader(value, source = "oauth2") {
    const normalized = String(value || "").trim();
    if (!isGarminBearer(normalized)) {
      return;
    }

    const previous = String(garminState.garminApiAuthHeaderCache || "");
    garminState.garminApiAuthHeaderCache = normalized;
    garminState.garminApiAuthHeaderCapturedAt = Date.now();

    const shouldLog =
      previous !== normalized || Date.now() - garminState.garminApiAuthHeaderLogAt > 60 * 1000;
    if (shouldLog) {
      garminState.garminApiAuthHeaderLogAt = Date.now();
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
      garminState.garminOauthConsumerCache &&
      typeof garminState.garminOauthConsumerCache.consumer_key === "string" &&
      typeof garminState.garminOauthConsumerCache.consumer_secret === "string"
    ) {
      return garminState.garminOauthConsumerCache;
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

    garminState.garminOauthConsumerCache = parsed;
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
      isGarminSignInUrl(response.url) ||
      (seemsLikeAuthHtml(response.url, contentType, bodyText) && !token);

    return {
      status: response.status,
      responseUrl: response.url,
      contentType,
      bodyText,
      token,
      authRequired
    };
  }

  async function getGarminAuthState(forceRefresh = false, silent = false) {
    if (!forceRefresh && garminState.garminCsrfTokenCache) {
      return {
        authenticated: true,
        token: garminState.garminCsrfTokenCache,
        reason: "token-cache"
      };
    }

    const page = await fetchGarminImportPage();
    const token = page.token;
    if (token) {
      garminState.garminCsrfTokenCache = token;
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

  async function ensureGarminImportTab(active = false, useSignInUrl = false) {
    const targetUrl = useSignInUrl ? GARMIN_SIGNIN_URL : GARMIN_MODERN_IMPORT_URL;
    const tabs = await chromeTabsQuery({ url: ["https://connect.garmin.com/*"] });
    const existing = tabs.find(
      (tab) => typeof tab?.url === "string" && tab.url.includes("/modern/import-data")
    );

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
    await appendLog("info", "Downloading FIT file", {
      index,
      url
    });

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

  Object.assign(MWG, {
    ensureGarminAuthenticatedInteractive,
    uploadOne
  });
})();
