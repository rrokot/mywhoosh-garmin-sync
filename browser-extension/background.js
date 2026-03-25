globalThis.MWG = globalThis.MWG || {};

importScripts(
  "vendor/crypto-js.min.js",
  "background/runtime.js",
  "background/garmin.js",
  "background/mywhoosh.js",
  "background/service-worker.js"
);
