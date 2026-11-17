"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadPopup(storage = {}) {
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          textContent: "", className: "", hidden: false, disabled: false,
          dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}
        });
        return elements.get(id);
      }
    },
    chrome: {
      tabs: { query: async () => [] },
      storage: { local: { get: async () => storage }, onChanged: { addListener() {}, removeListener() {} } }
    },
    window: { addEventListener() {} },
    URL, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../browser-extension/popup/popup.js"), "utf8"), context);
  return { view: (data) => context.buildViewModel(data), elements, context };
}

test("ready popup contains only the sync action, with no auth speculation or repeated status", () => {
  for (const data of [{}, {mywhooshAuth: {webToken: "saved"}}]) {
    const v = loadPopup().view(data);
    assert.equal(v.showResult, false);
    assert.equal(v.progressCopy, "");
    assert.equal(v.progressMeta, "");
    assert.equal(v.actionsEnabled, true);
  }
});

test("last sync shows only uploaded count even when summary includes duplicates and failures", () => {
  const v = loadPopup().view({syncStatus: "finished", lastUploadSummary: {totalNew: 5, uploaded: 2, duplicate: 1, failed: 2}});
  assert.equal(v.progressCopy, "Uploaded: 2");
  assert.equal(v.showResult, true);
  assert.doesNotMatch(JSON.stringify(v), /duplicate|failed|Finished with errors/);
});

test("login requires one contextual instruction and hides absent counters", () => {
  const v = loadPopup().view({syncInProgress: true, syncProgress: {phase: "waiting_mywhoosh_login"}});
  assert.equal(v.progressCopy, "Sign in to MyWhoosh in the opened tab.");
  assert.equal(v.progressMeta, "");
  assert.equal(v.actionsEnabled, false);
  assert.equal(v.showProgress, false);
  assert.doesNotMatch(JSON.stringify(v), /undefined|NaN/);
});

test("Garmin login pauses the progress bar", () => {
  const v = loadPopup().view({syncInProgress: true, syncProgress: {phase: "waiting_garmin_login", current: 2, total: 5, uploaded: 2}});
  assert.equal(v.showProgress, false);
  assert.match(v.progressCopy, /Garmin/);
});

test("empty completion still reports zero uploads", () => {
  const v = loadPopup().view({syncStatus: "finished", lastUploadSummary: {totalNew: 0}});
  assert.equal(v.progressCopy, "Uploaded: 0");
  assert.equal(v.tone, "neutral");
});

test("overall errors take precedence over old results and preserve diagnostic detail", () => {
  const v = loadPopup().view({syncStatus: "error", lastUserMessage: "Error: Garmin did not respond.", lastUploadSummary: {totalNew: 3, uploaded: 3}});
  assert.equal(v.tone, "error");
  assert.equal(v.progressCopy, "Sync failed");
  assert.equal(v.progressMeta, "Garmin did not respond.");
});

test("upload counts are bounded and announced only once", () => {
  const v = loadPopup().view({syncInProgress: true, syncProgress: {phase: "uploading", current: 9, total: 5, uploaded: 2, failed: "bad"}});
  assert.equal(v.progressCopy, "5 / 5 processed");
  assert.equal(v.progressMeta, "");
  assert.equal(v.showProgress, true);
  assert.equal(v.progressValue, 5);
  assert.equal(v.progressMax, 5);
});

test("interrupted runs allow restart with one short status", () => {
  const v = loadPopup().view({syncInProgress: true, syncStatusAt: "2000-01-01T00:00:00Z"});
  assert.equal(v.tone, "warning");
  assert.equal(v.progressCopy, "Sync interrupted");
  assert.equal(v.progressMeta, "");
  assert.equal(v.actionsEnabled, true);
});

test("checking never exposes raw background counter text", () => {
  const v = loadPopup().view({syncInProgress: true, syncStatusMessage: "Uploaded 3, failed 1", syncProgress: {phase: "checking"}});
  assert.equal(v.progressCopy, "Checking activities…");
  assert.equal(v.showProgress, false);
});
