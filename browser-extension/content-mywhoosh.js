function collectMyWhooshAuth() {
  let webToken = "";

  try {
    webToken = localStorage.getItem("webToken") || "";
  } catch (_) {
    // Ignore if localStorage is blocked.
  }

  return {
    webToken,
    pageUrl: location.href
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SHOW_COPYABLE_TEXT") {
    const text = String(message?.message || "");
    console.log("MyWhoosh -> Garmin:", text);
    window.prompt("MyWhoosh -> Garmin (copy):", text);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "COLLECT_MYWHOOSH_AUTH") {
    return undefined;
  }

  sendResponse({
    ok: true,
    ...collectMyWhooshAuth()
  });
  return false;
});
