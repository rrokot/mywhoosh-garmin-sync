"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMwg } = require("./harness");

const TOTAL_PAGES = 4;

// Page N holds activities N0, N1: newest first, like the real API with sortDate=DESC.
function pageActivities(page) {
  return [{ activityFileId: `${page}0` }, { activityFileId: `${page}1` }];
}

function keyOf(page, slot) {
  return `activity:${page}${slot}`;
}

function setup() {
  const requestedPages = [];
  const loaded = loadMwg({
    fetch: async (_url, init) => {
      const page = requestedPages.length + 1;
      requestedPages.push(page);
      const body = JSON.stringify({ results: pageActivities(page), totalPages: TOTAL_PAGES });
      assert.equal(init.method, "POST");
      return {
        ok: true,
        status: 200,
        url: String(_url),
        headers: { get: () => "application/json" },
        text: async () => body
      };
    }
  });

  return { MWG: loaded.MWG, requestedPages };
}

function processedSetFor(pages) {
  const processed = new Set();
  for (const page of pages) {
    processed.add(keyOf(page, 0));
    processed.add(keyOf(page, 1));
  }
  return processed;
}

test("a full scan is made when nothing is processed yet", async () => {
  const { MWG, requestedPages } = setup();

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: () => false,
    pendingKeys: [],
    allowEarlyStop: true
  });

  assert.deepEqual(requestedPages, [1, 2, 3, 4]);
  assert.equal(scan.activities.length, 8);
  assert.equal(scan.stoppedEarly, false);
  assert.equal(scan.completeScan, true);
});

test("paging stops after the first fully processed page", async () => {
  const { MWG, requestedPages } = setup();
  const processed = processedSetFor([1, 2, 3, 4]);

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: (key) => processed.has(key),
    pendingKeys: [],
    allowEarlyStop: true
  });

  assert.deepEqual(requestedPages, [1], "page 1 fully processed means every older page is too");
  assert.equal(scan.stoppedEarly, true);
  assert.equal(scan.completeScan, false);
});

test("paging continues past processed pages while new activities appear", async () => {
  const { MWG, requestedPages } = setup();
  const processed = processedSetFor([2, 3, 4]);

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: (key) => processed.has(key),
    pendingKeys: [],
    allowEarlyStop: true
  });

  assert.deepEqual(requestedPages, [1, 2], "page 1 is new, so page 2 must still be checked");
  assert.equal(scan.stoppedEarly, true);
});

test("a pending key from an older page keeps the scan going", async () => {
  const { MWG, requestedPages } = setup();
  // Everything is processed except one activity on page 2 that was listed
  // before and never uploaded.
  const processed = processedSetFor([1, 2, 3, 4]);
  processed.delete(keyOf(2, 1));

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: (key) => processed.has(key),
    pendingKeys: [keyOf(2, 1)],
    allowEarlyStop: true
  });

  assert.deepEqual(
    requestedPages,
    [1, 2, 3],
    "page 1 alone would have stopped the scan; the pending key forces page 2, then page 3 stops it"
  );
  assert.equal(scan.stoppedEarly, true);
  assert.ok(
    scan.activities.some((activity) => MWG.activityKey(activity) === keyOf(2, 1)),
    "the pending activity is part of the result"
  );
});

test("early stop is disabled until the pending set is known", async () => {
  const { MWG, requestedPages } = setup();
  const processed = processedSetFor([1, 2, 3, 4]);

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: (key) => processed.has(key),
    pendingKeys: [],
    allowEarlyStop: false
  });

  assert.deepEqual(requestedPages, [1, 2, 3, 4]);
  assert.equal(scan.stoppedEarly, false);
  assert.equal(scan.completeScan, true);
});

test("the last page never counts as an early stop", async () => {
  const { MWG, requestedPages } = setup();
  const processed = processedSetFor([4]);

  const scan = await MWG.fetchAllMyWhooshActivities("token", {
    isProcessed: (key) => processed.has(key),
    pendingKeys: [],
    allowEarlyStop: true
  });

  assert.deepEqual(requestedPages, [1, 2, 3, 4]);
  assert.equal(scan.stoppedEarly, false);
  assert.equal(scan.completeScan, true, "a complete scan lets stale pending keys be pruned");
});
