"use strict";

// Loads the real background modules in a vm sandbox with a minimal Chrome
// stub, so the pure helpers can be tested without a browser.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXTENSION_DIR = path.join(__dirname, "..", "browser-extension");
const MODULE_FILES = [
  "vendor/crypto-js.min.js",
  "background/runtime.js",
  "background/garmin.js",
  "background/mywhoosh.js"
];

function createStorageAreaStub(initial = {}) {
  const data = { ...initial };

  const readKeys = (keys) => {
    if (keys === null || keys === undefined) {
      return { ...data };
    }
    const list = Array.isArray(keys) ? keys : [keys];
    const result = {};
    for (const key of list) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        result[key] = data[key];
      }
    }
    return result;
  };

  return {
    data,
    get: async (keys) => readKeys(keys),
    set: async (values) => {
      Object.assign(data, values);
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
    clear: async () => {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    }
  };
}

function createChromeStub(options = {}) {
  const notifications = [];

  return {
    notifications,
    storage: {
      local: createStorageAreaStub(options.storage || {})
    },
    runtime: {
      lastError: null,
      getURL: (file) => `chrome-extension://test/${file}`,
      getManifest: () => ({ version: options.version || "0.0.0-test" })
    },
    notificationsApi: null,
    tabs: {
      query: (_query, cb) => cb([]),
      create: (_props, cb) => cb({ id: 1 }),
      update: (_id, _props, cb) => cb({ id: 1 }),
      get: (_id, cb) => cb({ id: 1, status: "complete" }),
      remove: (_ids, cb) => cb(),
      sendMessage: (_id, _msg, cb) => cb({ ok: true }),
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} }
    },
    scripting: {
      executeScript: async () => []
    }
  };
}

function loadMwg(options = {}) {
  const chromeStub = createChromeStub(options);
  chromeStub.notifications = {
    created: [],
    create(id, opts, cb) {
      chromeStub.notifications.created.push({ id, opts });
      if (typeof cb === "function") {
        cb(id);
      }
    }
  };

  const sandbox = {
    MWG: {},
    chrome: chromeStub,
    console,
    crypto: globalThis.crypto,
    fetch: options.fetch || (async () => {
      throw new Error("fetch is not stubbed in this test");
    }),
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob
  };

  const context = vm.createContext(sandbox);
  for (const file of MODULE_FILES) {
    const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }

  return { MWG: context.MWG, chrome: chromeStub, context };
}

// Values built inside the vm have their own intrinsics, so deepEqual against
// plain Node objects would fail on prototype identity alone.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadMwg, createChromeStub, createStorageAreaStub, plain, EXTENSION_DIR };
