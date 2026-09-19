"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadMwg, createChromeStub, EXTENSION_DIR } = require("./harness");

const MODULES = ["background/runtime.js", "background/garmin.js", "background/mywhoosh.js", "background/service-worker.js"];

// Every module pulls its dependencies out of the shared MWG namespace, where a
// typo silently yields undefined instead of failing at load time.
function destructuredNames(source) {
  const match = source.match(/const\s*\{([\s\S]*?)\}\s*=\s*MWG;/);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((entry) => entry.split(":")[0].trim())
    .filter((entry) => entry !== "");
}

test("every name imported from MWG is actually exported", () => {
  const { MWG } = loadMwg();
  // runtime.js is the only module loaded before the others in the harness;
  // garmin.js and mywhoosh.js add their own exports on top.
  const exported = new Set(Object.keys(MWG));
  const missing = [];

  for (const file of MODULES) {
    const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
    for (const name of destructuredNames(source)) {
      if (!exported.has(name)) {
        missing.push(`${file}: ${name}`);
      }
    }
  }

  assert.deepEqual(missing, [], "unresolved MWG imports");
});

test("the service worker registers its listeners and no longer uses action.onClicked", () => {
  const messageListeners = [];
  const chromeStub = createChromeStub();
  chromeStub.notifications = { create() {} };
  chromeStub.runtime.onMessage = {
    addListener: (fn) => messageListeners.push(fn)
  };
  chromeStub.action = {
    onClicked: {
      addListener: () => {
        throw new Error("action.onClicked never fires while a default_popup is set");
      }
    }
  };

  const sandbox = {
    MWG: {},
    chrome: chromeStub,
    console,
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error("no network in this test");
    },
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams
  };
  const context = vm.createContext(sandbox);
  for (const file of ["vendor/crypto-js.min.js", ...MODULES]) {
    vm.runInContext(fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8"), context, { filename: file });
  }

  assert.equal(messageListeners.length, 1, "one runtime.onMessage listener");
});

test("the manifest matches the hosts the code talks to", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const { MWG } = loadMwg();

  assert.ok(!manifest.host_permissions.includes("<all_urls>"), "no blanket host permission");

  const patterns = manifest.host_permissions.map((pattern) => {
    const host = new URL(pattern.replace("*.", "wildcard.")).host;
    return host.startsWith("wildcard.") ? host.slice("wildcard.".length) : host;
  });
  const covered = (url) => {
    const host = new URL(url).host;
    return patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
  };

  for (const url of [
    MWG.MYWHOOSH_ACTIVITIES_URL,
    MWG.MYWHOOSH_DOWNLOAD_URL,
    MWG.MYWHOOSH_APP_ENTRY_URL,
    MWG.GARMIN_CONNECTAPI_UPLOAD_URL,
    MWG.GARMIN_SSO_SIGNIN_URL,
    MWG.GARMIN_OAUTH_CONSUMER_URL
  ]) {
    assert.ok(covered(url), `${url} is not covered by host_permissions`);
  }

  // The presigned FIT links observed in the wild live in this bucket.
  assert.ok(
    covered("https://mywhooshprod.s3.eu-west-1.amazonaws.com/ride/x.fit"),
    "FIT download bucket is not covered by host_permissions"
  );
});
