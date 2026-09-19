"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const { loadMwg } = require("./harness");

const { MWG } = loadMwg();

const NONCE = "0123456789abcdef0123456789abcdef";
const TIMESTAMP = 1700000000;

function parseAuthorizationHeader(header) {
  assert.match(header, /^OAuth /);
  const params = {};
  for (const part of header.slice("OAuth ".length).split(", ")) {
    const eq = part.indexOf("=");
    const key = decodeURIComponent(part.slice(0, eq));
    params[key] = decodeURIComponent(part.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return params;
}

// Independent RFC 5849 §3.4.1 implementation, so the assertion checks the
// extension's base string rather than just re-running its own code.
function expectedSignature({ method, url, consumerSecret, tokenSecret = "", extraParams = {}, oauthParams }) {
  const encode = (value) =>
    encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  const parsed = new URL(url);
  const pairs = [];
  parsed.searchParams.forEach((value, key) => pairs.push([key, value]));
  for (const [key, value] of Object.entries(extraParams)) {
    pairs.push([key, String(value)]);
  }
  for (const [key, value] of Object.entries(oauthParams)) {
    pairs.push([key, String(value)]);
  }

  const normalized = pairs
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const baseString = [method.toUpperCase(), encode(baseUrl), encode(normalized)].join("&");
  const signingKey = `${encode(consumerSecret)}&${encode(tokenSecret)}`;

  return nodeCrypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

test("OAuth1 header signs a GET with query parameters", () => {
  const url = "https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-1&accepts-mfa-tokens=true";
  const header = MWG.buildGarminOAuth1AuthorizationHeader({
    method: "GET",
    url,
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    nonce: NONCE,
    timestamp: TIMESTAMP
  });
  const params = parseAuthorizationHeader(header);

  assert.equal(params.oauth_consumer_key, "consumer-key");
  assert.equal(params.oauth_nonce, NONCE);
  assert.equal(params.oauth_timestamp, String(TIMESTAMP));
  assert.equal(params.oauth_signature_method, "HMAC-SHA1");
  assert.equal(params.oauth_version, "1.0");
  assert.equal(params.oauth_token, undefined, "no token on the preauthorized call");

  assert.equal(
    params.oauth_signature,
    expectedSignature({
      method: "GET",
      url,
      consumerSecret: "consumer-secret",
      oauthParams: {
        oauth_consumer_key: "consumer-key",
        oauth_nonce: NONCE,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: TIMESTAMP,
        oauth_version: "1.0"
      }
    })
  );
});

test("OAuth1 header signs a POST exchange with token and body params", () => {
  const url = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
  const header = MWG.buildGarminOAuth1AuthorizationHeader({
    method: "POST",
    url,
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    token: "oauth-token",
    tokenSecret: "oauth-token-secret",
    bodyParams: { mfa_token: "mfa-1" },
    nonce: NONCE,
    timestamp: TIMESTAMP
  });
  const params = parseAuthorizationHeader(header);

  assert.equal(params.oauth_token, "oauth-token");
  assert.equal(
    params.oauth_signature,
    expectedSignature({
      method: "POST",
      url,
      consumerSecret: "consumer-secret",
      tokenSecret: "oauth-token-secret",
      extraParams: { mfa_token: "mfa-1" },
      oauthParams: {
        oauth_consumer_key: "consumer-key",
        oauth_nonce: NONCE,
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: TIMESTAMP,
        oauth_token: "oauth-token",
        oauth_version: "1.0"
      }
    })
  );
});

test("OAuth1 header skips empty body params", () => {
  const url = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
  const withEmpty = MWG.buildGarminOAuth1AuthorizationHeader({
    method: "POST",
    url,
    consumerKey: "k",
    consumerSecret: "s",
    token: "t",
    tokenSecret: "ts",
    bodyParams: { mfa_token: "" },
    nonce: NONCE,
    timestamp: TIMESTAMP
  });
  const withoutAny = MWG.buildGarminOAuth1AuthorizationHeader({
    method: "POST",
    url,
    consumerKey: "k",
    consumerSecret: "s",
    token: "t",
    tokenSecret: "ts",
    nonce: NONCE,
    timestamp: TIMESTAMP
  });

  assert.equal(withEmpty, withoutAny);
});

test("encodeRfc3986 escapes the characters encodeURIComponent leaves alone", () => {
  assert.equal(MWG.encodeRfc3986("a!b'c(d)e*f"), "a%21b%27c%28d%29e%2Af");
  assert.equal(MWG.encodeRfc3986("a b+c/d"), "a%20b%2Bc%2Fd");
  assert.equal(MWG.encodeRfc3986("-._~"), "-._~", "unreserved characters stay literal");
});

test("OAuth1 header rejects an incomplete config", () => {
  assert.throws(
    () => MWG.buildGarminOAuth1AuthorizationHeader({ method: "GET", url: "https://x.test/" }),
    /OAuth1 header config is incomplete/
  );
});
