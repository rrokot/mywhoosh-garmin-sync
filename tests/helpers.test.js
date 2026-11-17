"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMwg, plain } = require("./harness");

const { MWG } = loadMwg();

test("activityKey prefers the file id over the download url", () => {
  assert.equal(MWG.activityKey({ activityFileId: "42" }), "activity:42");
  assert.equal(MWG.activityKey({ fileId: " 42 " }), "activity:42");
  assert.equal(MWG.activityKey({ activity_file_id: 42 }), "activity:42");
  assert.equal(MWG.activityKey({ id: 7, activityFileId: "42" }), "activity:42");
});

test("activityKey falls back to a query-independent url key", () => {
  const first = MWG.activityKey({ downloadUrl: "https://s3.test/ride/A.fit?Signature=one" });
  const second = MWG.activityKey({ downloadUrl: "https://s3.test/ride/A.fit?Signature=two" });

  assert.equal(first, second, "presigned query params must not change the key");
  assert.equal(first, "url:/ride/a.fit");
});

test("fitKey normalizes case and percent-encoding", () => {
  assert.equal(MWG.fitKey("https://s3.test/Ride/A%20B.fit?x=1"), "/ride/a b.fit");
  assert.equal(MWG.fitKey("not a url"), "not a url");
  assert.equal(MWG.fitKey(""), "");
});

test("inferFilename reads content-disposition before the url", () => {
  assert.equal(MWG.inferFilename("https://s3.test/x.fit", 'attachment; filename="ride.fit"', 1), "ride.fit");
  assert.equal(
    MWG.inferFilename("https://s3.test/x.fit", "attachment; filename*=UTF-8''%D0%B7%D0%B0%D0%B5%D0%B7%D0%B4.fit", 1),
    "заезд.fit"
  );
  assert.equal(MWG.inferFilename("https://s3.test/ride/A%20B.fit?sig=1", null, 1), "A B.fit");
  assert.match(MWG.inferFilename("not a url", null, 3), /^mywhoosh_activity_\d+_3\.fit$/);
});

test("looksLikeDuplicate covers the statuses Garmin actually returns", () => {
  assert.equal(MWG.looksLikeDuplicate(409, ""), true);
  assert.equal(MWG.looksLikeDuplicate(200, "Activity already exists"), true);
  assert.equal(MWG.looksLikeDuplicate(200, '{"messages":["DUPLICATE activity"]}'), true);
  assert.equal(MWG.looksLikeDuplicate(200, '{"detailedImportResult":{"successes":[1]}}'), false);
  assert.equal(MWG.looksLikeDuplicate(500, ""), false);
});

test("hasUploadFailures detects both failure shapes", () => {
  assert.equal(MWG.hasUploadFailures({ failures: [{ id: 1 }] }), true);
  assert.equal(MWG.hasUploadFailures({ detailedImportResult: { failures: [{ id: 1 }] } }), true);
  assert.equal(MWG.hasUploadFailures({ success: false }), true);
  assert.equal(MWG.hasUploadFailures({ detailedImportResult: { failures: [] } }), false);
  assert.equal(MWG.hasUploadFailures(null), false);
});

test("isMyWhooshUrl accepts mywhoosh subdomains only", () => {
  assert.equal(MWG.isMyWhooshUrl("https://event.mywhoosh.com/user/activities"), true);
  assert.equal(MWG.isMyWhooshUrl("https://service14.mywhoosh.com/v2"), true);
  assert.equal(MWG.isMyWhooshUrl("https://mywhoosh.com.evil.test/"), false);
  assert.equal(MWG.isMyWhooshUrl("https://garmin.com/"), false);
  assert.equal(MWG.isMyWhooshUrl(""), false);
});

test("normalizeActivitiesPayload handles every response shape", () => {
  assert.deepEqual(plain(MWG.normalizeActivitiesPayload([1, 2])), { results: [1, 2], totalPages: 1 });
  assert.deepEqual(plain(MWG.normalizeActivitiesPayload({ results: [1], totalPages: 4 })), {
    results: [1],
    totalPages: 4
  });
  assert.deepEqual(plain(MWG.normalizeActivitiesPayload({ data: { results: [1], lastPage: "3" } })), {
    results: [1],
    totalPages: 3
  });
  assert.deepEqual(plain(MWG.normalizeActivitiesPayload({ data: [1] })), { results: [1], totalPages: 1 });
  assert.deepEqual(plain(MWG.normalizeActivitiesPayload({ nope: true })), { results: [], totalPages: 1 });
});

test("resolveDownloadUrl finds the url wherever the API puts it", () => {
  assert.equal(MWG.resolveDownloadUrl("https://s3.test/a.fit"), "https://s3.test/a.fit");
  assert.equal(MWG.resolveDownloadUrl({ data: "https://s3.test/a.fit" }), "https://s3.test/a.fit");
  assert.equal(MWG.resolveDownloadUrl({ data: { fileUrl: "https://s3.test/a.fit" } }), "https://s3.test/a.fit");
  assert.equal(MWG.resolveDownloadUrl({ data: { fileUrl: "/relative.fit" } }), null);
  assert.equal(MWG.resolveDownloadUrl(null), null);
});

test("uniqueActivities keeps the first entry per key", () => {
  const result = MWG.uniqueActivities([
    { activityFileId: "1", tag: "first" },
    { activityFileId: "1", tag: "second" },
    { activityFileId: "2", tag: "other" }
  ]);

  assert.deepEqual(plain(result.map((item) => item.tag)), ["first", "other"]);
});

test("extractFileId walks the id aliases in order", () => {
  assert.equal(MWG.extractFileId({ id: 9, fileId: "5" }), "5");
  assert.equal(MWG.extractFileId({ id: 9 }), "9");
  assert.equal(MWG.extractFileId({ id: "  " }), null);
  assert.equal(MWG.extractFileId({}), null);
});

test("extractGarminSsoTicket reads the ticket from url or body", () => {
  assert.equal(
    MWG.extractGarminSsoTicket("https://sso.garmin.com/sso/embed?ticket=ST-123-abc", ""),
    "ST-123-abc"
  );
  assert.equal(
    MWG.extractGarminSsoTicket("https://sso.garmin.com/sso/signin", 'href="/sso/embed?ticket=ST-9&amp;x=1"'),
    "ST-9"
  );
  assert.equal(MWG.extractGarminSsoTicket("https://sso.garmin.com/sso/signin", "<html></html>"), null);
});

test("isGarminSsoEmbedTicketUrl only matches the embed callback", () => {
  assert.equal(MWG.isGarminSsoEmbedTicketUrl("https://sso.garmin.com/sso/embed?ticket=ST-1"), true);
  assert.equal(MWG.isGarminSsoEmbedTicketUrl("https://sso.garmin.com/sso/embed"), false);
  assert.equal(MWG.isGarminSsoEmbedTicketUrl("https://sso.garmin.com/sso/signin?ticket=ST-1"), false);
});

test("parseHtmlTitle extracts the sign-in page title", () => {
  assert.equal(MWG.parseHtmlTitle("<html><head><title> Sign In </title></head></html>"), "Sign In");
  assert.equal(MWG.parseHtmlTitle("<html></html>"), "");
  assert.equal(MWG.parseHtmlTitle(null), "");
});
