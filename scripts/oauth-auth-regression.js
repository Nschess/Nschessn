"use strict";

const assert = require("assert");
const path = require("path");

const policy = require(path.join(__dirname, "..", "assets", "auth-redirect-policy.js"));

function expectThrow(callback, code) {
  try {
    callback();
  } catch (error) {
    assert.strictEqual(error.code, code);
    return;
  }
  assert.fail(`Expected ${code}`);
}

assert.strictEqual(
  policy.createTrustedRedirectUrl({
    currentOrigin: "https://nschessn.vercel.app",
    allowedOrigins: ["https://nschessn.vercel.app"],
    flow: "oauth"
  }),
  "https://nschessn.vercel.app/?auth=oauth"
);

assert.strictEqual(
  policy.createTrustedRedirectUrl({
    currentOrigin: "http://127.0.0.1:4173",
    allowedOrigins: ["http://127.0.0.1:4173"],
    flow: "session"
  }),
  "http://127.0.0.1:4173/"
);

assert.deepStrictEqual(
  policy.trustedOrigins([
    "https://nschessn.vercel.app",
    "https://nschessn.vercel.app/",
    "https://evil.example",
    "javascript:alert(1)",
    "https://nschessn.vercel.app/not-an-origin"
  ]),
  ["https://nschessn.vercel.app", "https://evil.example"]
);

expectThrow(() => policy.createTrustedRedirectUrl({
  currentOrigin: "https://evil.example",
  allowedOrigins: ["https://nschessn.vercel.app"],
  flow: "oauth"
}), "AUTH_REDIRECT_ORIGIN_UNTRUSTED");

expectThrow(() => policy.createTrustedRedirectUrl({
  currentOrigin: "http://nschessn.vercel.app",
  allowedOrigins: ["https://nschessn.vercel.app"],
  flow: "oauth"
}), "AUTH_REDIRECT_ORIGIN_UNTRUSTED");

console.log("OAuth redirect policy regression: PASS");
