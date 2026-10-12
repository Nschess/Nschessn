"use strict";
// Real Chromium / built artifact, loopback only. No authenticated services.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
async function cacheContract() {
  const handlers = {}, rows = new Map(), deleted = [];
  const cache = { addAll: async () => { throw Error("failed update"); },
    put: async (r) => rows.set(r.url, r), keys: async () => [...rows.values()],
    delete: async (r) => { rows.delete(r.url); return true; } };
  vm.runInNewContext(worker, { URL, Set, Promise, Response,
    self: { location: { href: "https://example.test/service-worker.js", origin: "https://example.test" },
      addEventListener: (k, f) => { handlers[k] = f; }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: async () => cache, match: async () => null, keys: async () => ["nschess-shell-old"], delete: async (k) => deleted.push(k) },
    fetch: async () => new Response("public", { status: 200 }) });
  let install;
  handlers.install({ waitUntil: (p) => { install = p; } });
  await assert.rejects(install, /failed update/);
  assert.equal(deleted.length, 0, "Failed installation must preserve old cache");
  async function request(url, mode = "cors", headers = {}) {
    let response; const waits = [];
    handlers.fetch({ request: { url: `https://example.test${url}`, method: "GET", mode, headers: new Headers(headers) },
      respondWith: (p) => { response = p; }, waitUntil: (p) => waits.push(p) });
    if (response) await response;
    await Promise.all(waits);
    return Boolean(response);
  }
  for (const url of ["/api/auth-config", "/api/store", "/private.json", "/?code=secret", "/assets/app.js?token=secret"]) {
    assert.equal(await request(url, url.startsWith("/?") ? "navigate" : "cors"), false, url);
  }
  assert.equal(await request("/assets/app.js", "cors", { authorization: "Bearer synthetic" }), false);
  for (let i = 0; i < 170; i++) await request(`/assets/pieces/test${i}.svg`);
  assert.equal(rows.size, 160, "Optional public cache must be bounded");
}
async function main() {
  await cacheContract();
  const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".webmanifest": "application/manifest+json", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
  let shellUnavailable = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (shellUnavailable && pathname === "/assets/app.css") return res.writeHead(503).end();
    const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(dist + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = { manifest: null, installability: null, layouts: [], cache: {}, physicalInstallation: "NOT TESTED" };
  fs.mkdirSync(path.join(root, "e2e-artifacts/pwa"), { recursive: true });
  try {
    const context = await browser.newContext();
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    const page = await context.newPage();
    await page.goto(origin + "/#settings", { waitUntil: "load" });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "load" });
    const cdp = await context.newCDPSession(page);
    report.manifest = await cdp.send("Page.getAppManifest");
    assert.equal(report.manifest.errors.length, 0);
    report.installability = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(report.installability.installabilityErrors, []);
    for (const size of [192, 512]) {
      assert.equal(await page.evaluate(async (size) => {
        const img = new Image(); img.src = `/assets/icons/icon-${size}.png`; await img.decode();
        return img.naturalWidth === size && img.naturalHeight === size;
      }, size), true);
    }
    await page.locator("#pwaInstall").click();
    assert.match(await page.locator("#pwaInstallStatus").textContent(), /Chrome or Edge/);
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = async () => { window.__promptCalls = (window.__promptCalls || 0) + 1; };
      event.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(event);
    });
    await page.locator("#pwaInstall").click();
    assert.equal(await page.evaluate(() => window.__promptCalls), 1);
    assert.match(await page.locator("#pwaInstallStatus").textContent(), /Installation requested/);
    assert.doesNotMatch(await page.locator("#pwaInstallStatus").textContent(), /confirmed/);
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    assert.match(await page.locator("#pwaInstallStatus").textContent(), /Browser confirmed/);
    for (const width of [320, 375, 390, 768, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ media: "screen" });
      await page.waitForTimeout(150);
      const bounds = await page.locator("#pwaInstall").boundingBox();
      assert.ok(bounds.height >= 44);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      report.layouts.push({ width, buttonHeight: bounds.height, overflow: false });
      await page.screenshot({ path: path.join(root, `e2e-artifacts/pwa/settings-${width}.png`) });
    }
    await page.locator("a[data-site-tab='play']").first().click();
    await page.goBack();
    await page.locator("#pwaInstall").waitFor({ state: "visible" });
    report.backNavigation = "PASS";
    const before = await page.evaluate(async () => (await caches.match("/assets/app.css?v=daily-compact-v1")).text());
    shellUnavailable = true;
    await page.evaluate(() => fetch("/assets/app.css?v=daily-compact-v1").then((r) => r.text()));
    assert.equal(await page.evaluate(async () => (await caches.match("/assets/app.css?v=daily-compact-v1")).text()), before);
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    assert.ok(await page.locator("#pwaInstall").count());
    report.cache = await page.evaluate(async () => ({ scope: (await navigator.serviceWorker.ready).scope,
      names: await caches.keys(), entries: (await (await caches.open((await caches.keys())[0])).keys()).map((r) => new URL(r.url).pathname) }));
    assert.ok(report.cache.entries.every((p) => !p.includes("/api/")));
    fs.writeFileSync(path.join(root, "e2e-artifacts/pwa/report.json"), JSON.stringify(report, null, 2));
    console.log("PASS: real Chromium installability, icons, install gesture contract, five layouts, offline shell, 503 preservation; production worker cache boundary/failed-install/bounded-cache contracts.");
    await context.close();
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
