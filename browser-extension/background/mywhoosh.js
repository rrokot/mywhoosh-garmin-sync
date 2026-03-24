(() => {
  const MWG = globalThis.MWG;
  const {
    MYWHOOSH_ACTIVITIES_URL,
    MYWHOOSH_AES_KEY,
    MYWHOOSH_DEFAULT_SORT,
    MYWHOOSH_DEFAULT_TYPE,
    MYWHOOSH_DOWNLOAD_URL,
    MYWHOOSH_MAX_PAGES,
    activityKey,
    appendLog
  } = MWG;

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
      const authLike =
        response.status === 401 ||
        response.status === 403 ||
        /unauthorized|forbidden|invalid token|token expired|jwt|not logged in/i.test(detail);
      const error = new Error(
        `MyWhoosh API failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`
      );
      error.mywhooshAuth = authLike;
      error.httpStatus = response.status;
      throw error;
    }

    return data;
  }

  async function fetchMyWhooshActivitiesPage(token, page) {
    const payload = {
      type: MYWHOOSH_DEFAULT_TYPE,
      page,
      sortDate: MYWHOOSH_DEFAULT_SORT
    };

    const data = await requestMyWhooshApi(MYWHOOSH_ACTIVITIES_URL, token, payload);
    const normalized = normalizeActivitiesPayload(data);
    await appendLog("info", "MyWhoosh activities page fetched", {
      page,
      fetched: normalized.results.length,
      totalPages: normalized.totalPages || 1
    });

    return normalized;
  }

  async function fetchAllMyWhooshActivities(token) {
    const all = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= MYWHOOSH_MAX_PAGES) {
      const normalized = await fetchMyWhooshActivitiesPage(token, page);
      all.push(...normalized.results);
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

  async function fetchLatestNewMyWhooshActivity(token, processed) {
    const seenKeys = new Set();
    let scannedCount = 0;
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= MYWHOOSH_MAX_PAGES) {
      const normalized = await fetchMyWhooshActivitiesPage(token, page);
      totalPages = Math.max(totalPages, normalized.totalPages || 1);

      for (const activity of normalized.results || []) {
        const key = activityKey(activity);
        if (seenKeys.has(key)) {
          continue;
        }

        seenKeys.add(key);
        scannedCount += 1;
        if (!processed[key]) {
          await appendLog("info", "Latest new MyWhoosh activity found", {
            key,
            page,
            scannedCount
          });
          return {
            activity,
            scannedCount
          };
        }
      }

      page += 1;
    }

    await appendLog("info", "No new MyWhoosh activity found for latest mode", {
      scannedCount
    });
    return {
      activity: null,
      scannedCount
    };
  }

  async function fetchMyWhooshDownloadUrl(token, fileId) {
    const data = await requestMyWhooshApi(MYWHOOSH_DOWNLOAD_URL, token, { fileId });
    const url = resolveDownloadUrl(data);

    if (!url) {
      throw new Error(`Download URL not found for fileId ${fileId}`);
    }

    return url;
  }

  Object.assign(MWG, {
    extractFileId,
    fetchAllMyWhooshActivities,
    fetchLatestNewMyWhooshActivity,
    fetchMyWhooshDownloadUrl
  });
})();
