"use strict";
// Loopback rehearsal of this repository's explicit Vercel rules. This verifies
// intended HTTP/browser behavior, not Vercel's deployed routing implementation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");
const { origin, pages, legalPages, home } = require("./seo-pages.cjs");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const matches = (rule, url) => (rule.source.endsWith("/:path*")
  ? url.pathname.startsWith(rule.source.replace(":path*", "")) : rule.source === url.pathname)
  && (!rule.has || rule.has.every((condition) => condition.type === "query" && url.searchParams.has(condition.key)));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain", ".wasm": "application/wasm" };
async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    for (const rule of config.headers) if (matches(rule, url)) for (const header of rule.headers) response.setHeader(header.key, header.value);
    const redirect = config.redirects.find((rule) => rule.source === url.pathname);
    if (redirect) return response.writeHead(redirect.permanent ? 308 : 307, { Location: redirect.destination + url.search }).end();
    if (url.pathname.startsWith("/api/")) return response.writeHead(503, { "Content-Type": "application/json" }).end('{"code":"INTEGRATION_OFFLINE_FIXTURE"}');
    const file = path.resolve(dist, "." + (url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname));
    if (!file.startsWith(dist + path.sep)) return response.writeHead(403).end();
    fs.readFile(file, (error, bytes) => {
      if (error) return response.writeHead(404, { "Content-Type": "text/html" }).end(fs.readFileSync(path.join(dist, "404.html")));
      response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      response.end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    for (const entry of [home, ...pages, ...legalPages]) {
      const response = await fetch(base + entry.path);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(`href="${origin + entry.path}"`));
      assert.equal(response.headers.get("x-robots-tag"), null, "Public canonical responses stay indexable");
    }
    for (const redirect of config.redirects) {
      const response = await fetch(base + redirect.source + "?utm_source=integration", { redirect: "manual" });
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), redirect.destination + "?utm_source=integration");
      assert.equal((await fetch(base + redirect.source)).status, 200, "Aliases resolve without loops");
    }
    for (const query of ["code", "access_token", "refresh_token", "token", "error", "state", "challenge", "spectate", "tournament"]) {
      const response = await fetch(`${base}/?${query}=synthetic`);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    for (const route of ["/api/auth-config", "/data/puzzles.json", "/offline.html", "/404.html"]) assert.equal((await fetch(base + route)).headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal((await fetch(base + "/missing-integration-route")).status, 404);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    await context.addInitScript(() => localStorage.setItem("checkmateQuest.firstVisitSetup.v1", '{"done":true}'));
    const page = await context.newPage();
    await page.goto(base + "/index.html?code=synthetic#login", { waitUntil: "domcontentloaded" });
    await page.locator("#login.is-active-panel").waitFor({ state: "visible" });
    assert.ok(page.url().includes("/?code=synthetic#login"), "Homepage redirect preserves OAuth query and browser fragment");
    assert.match(await page.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    await page.goto(base + "/chess-training", { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).pathname, "/chess-training/");
    await page.locator(".hero .button").click();
    await page.locator("#dailyPracticeHub").waitFor({ state: "visible" });
    await page.goBack(); assert.equal(new URL(page.url()).pathname, "/chess-training/");
    await page.goForward(); await page.locator("#dailyPracticeHub").waitFor({ state: "visible" });
    await page.reload(); await page.locator("#dailyPracticeHub").waitFor({ state: "visible" });
    const marker = "SYNTHETIC_PRIVATE_INTEGRATION_MARKER";
    await page.evaluate((value) => { localStorage.setItem("checkmateQuest.dailyPractice.v1", JSON.stringify({ version: 1, privateMarker: value, days: {} })); document.getElementById("dailyPracticeStatus").textContent = value; }, marker);
    const html = await (await fetch(base + "/")).text();
    const sitemap = await (await fetch(base + "/sitemap.xml")).text();
    assert.ok(!html.includes(marker) && !sitemap.includes(marker), "Client-local identity/progress is never serialized into public artifacts");
    assert.equal(await page.locator("#plan").getAttribute("data-nosnippet"), "");
    await context.close();
    console.log("PASS: local HTTP routing rehearsal: 13 canonical pages, 19 permanent aliases without loops, query/fragment preservation, sensitive noindex/no-store headers, real 404, Daily Practice back/forward/refresh and no private data in static HTML/sitemap. Actual Vercel CDN verification remains required on preview.");
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
