"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMwg } = require("./harness");

function linesIn(chrome) {
  return chrome.storage.local.data.syncLogLines || [];
}

test("log lines are flushed to storage, but not on every call", async () => {
  const { MWG, chrome } = loadMwg();

  await MWG.appendLog("info", "first");
  await MWG.appendLog("info", "second");
  assert.deepEqual(linesIn(chrome), [], "info entries are debounced");

  await MWG.flushLogs();
  const lines = linesIn(chrome);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^MWGLOG \S+ \[info\] first$/);
  assert.equal(chrome.storage.local.data.lastLogLine, lines[1]);
});

test("error entries are flushed immediately", async () => {
  const { MWG, chrome } = loadMwg();

  await MWG.appendLog("error", "boom", { detail: "x" });
  const lines = linesIn(chrome);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[error\] boom \| \{"detail":"x"\}$/);
});

test("the legacy syncLogs buffer is dropped instead of rewritten", async () => {
  const { MWG, chrome } = loadMwg({ storage: { syncLogs: [{ message: "old" }] } });

  await MWG.appendLog("info", "new entry");
  await MWG.flushLogs();

  assert.equal(chrome.storage.local.data.syncLogs, undefined);
  assert.equal(linesIn(chrome).length, 1);
});

test("concurrent first writes do not lose entries to the initial load", async () => {
  const { MWG, chrome } = loadMwg({ storage: { syncLogLines: ["MWGLOG old line"] } });

  await Promise.all([
    MWG.appendLog("info", "a"),
    MWG.appendLog("info", "b"),
    MWG.appendLog("info", "c")
  ]);
  await MWG.flushLogs();

  const lines = linesIn(chrome);
  assert.equal(lines.length, 4, "the stored line plus all three new ones");
  assert.equal(lines[0], "MWGLOG old line");
  for (const message of ["a", "b", "c"]) {
    assert.ok(
      lines.some((line) => line.endsWith(`[info] ${message}`)),
      `entry ${message} survived`
    );
  }
});

test("the line buffer is capped", async () => {
  const existing = Array.from({ length: 1200 }, (_, i) => `MWGLOG line ${i}`);
  const { MWG, chrome } = loadMwg({ storage: { syncLogLines: existing } });

  await MWG.appendLog("info", "newest");
  await MWG.flushLogs();

  const lines = linesIn(chrome);
  assert.equal(lines.length, 1200);
  assert.equal(lines[0], "MWGLOG line 1", "the oldest line is dropped");
  assert.match(lines[lines.length - 1], /\[info\] newest$/);
});

test("long payloads are truncated in the flat line", async () => {
  const { MWG, chrome } = loadMwg();

  await MWG.appendLog("info", "big", { blob: "x".repeat(2000) });
  await MWG.flushLogs();

  const line = linesIn(chrome)[0];
  assert.ok(line.length < 900, `line was ${line.length} chars`);
  assert.ok(line.endsWith("..."));
});
