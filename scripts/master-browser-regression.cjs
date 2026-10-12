"use strict";
// Built-artifact guest inspection; all remote services are blocked/mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");
const root = path.resolve(__dirname, "..");
const artifact = path.join(root, "dist");
const label = process.env.MASTER_LABEL || "after";
const output = path.join(root, "e2e-artifacts", "phase10", label);
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm" };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  let failShell = false;
  let measureBaseline = false;
  const baseSources = new Map();
  if (process.env.MASTER_MEASURE) {
    for (const name of ["assets/app.js", "assets/app.css", "service-worker.js"]) {
      const source = execFileSync("git", ["show", `6c07f4fb7d3b4b698dcc410e443ff521ad5765f1:${name}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString("utf8");
      // Match the build's checkout line endings for comparable byte counts.
      baseSources.set(`/${name}`, fs.readFileSync(path.join(artifact, name), "utf8").includes("\r\n") ? source.replace(/\r?\n/g, "\r\n") : source);
    }
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/__cache_probe") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Local cache regression</title>");
    if (failShell && pathname === "/assets/app.css") return res.writeHead(503).end("Synthetic unavailable response");
    if (measureBaseline && baseSources.has(pathname)) return res.writeHead(200, { "Content-Type": mime[path.extname(pathname)], "Cache-Control": "no-store" }).end(baseSources.get(pathname));
    const file = path.resolve(artifact, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(artifact + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const report = { label, viewports: [], routes: [], errors: [] };
  try {
    if (process.env.MASTER_MEASURE) {
      const samples = [];
      for (let i = 0; i < 6; i++) {
        measureBaseline = i % 2 === 0;
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
        await context.route("https://**/*", (route) => route.abort());
        await installOfflineSupabaseFixture(context);
        await installOptionalCdnFixtures(context);
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
        await page.waitForTimeout(1200);
        const metrics = await page.evaluate(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          const resources = performance.getEntriesByType("resource").filter((e) => new URL(e.name).origin === location.origin);
          return { dclMs: Math.round(navigation.domContentLoadedEventEnd), loadMs: Math.round(navigation.loadEventEnd),
            authConfigRequests: resources.filter((e) => e.name.includes("/api/auth-config")).length,
            decodedBytes: resources.reduce((sum, e) => sum + e.decodedBodySize, 0), nodes: document.querySelectorAll("*").length,
            eagerDailyOrEngine: resources.some((e) => /daily-puzzle\.mjs|daily-puzzles-original|stockfish/.test(e.name)) };
        });
        samples.push({ source: measureBaseline ? "base-6c07f4f" : "candidate", ...metrics });
        await context.close();
      }
      fs.writeFileSync(path.join(output, "performance.json"), JSON.stringify(samples, null, 2));
      console.log(JSON.stringify(samples, null, 2));
      return;
    }
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    await context.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    if (await page.locator("#firstVisitSetup").isVisible()) await page.locator("#firstVisitSetupLater").click();
    report.startup = await page.evaluate(() => ({
      dcl: performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,
      load: performance.getEntriesByType("navigation")[0].loadEventEnd,
      resources: performance.getEntriesByType("resource").filter((e) => new URL(e.name).origin === location.origin).map((e) => ({ path: new URL(e.name).pathname, bytes: e.decodedBodySize, ms: e.duration })),
      longTasks: window.__longTasks, nodes: document.querySelectorAll("*").length
    }));
    const routes = process.env.MASTER_RECOVERY_ONLY ? [] : process.env.MASTER_ROUTES?.split(",") || ["top", "play", "bots", "puzzles", "tutorial", "game-review", "friends", "login", "store", "settings", "leaderboards", "academy", "paths", "adventures", "rules", "openings", "books", "notation", "plan", "videos"];
    for (const route of routes) {
      console.log(`Inspect ${route}`);
      const start = Date.now();
      await page.evaluate((route) => { location.hash = route; }, route);
      const id = route === "game-review" ? "gameReview" : route;
      await page.locator(`#${id}`).waitFor({ state: "visible" });
      await page.waitForTimeout(350);
      report.routes.push({ route, ms: Date.now() - start });
      for (const width of [1366, 980, 390, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(80);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const sample = await page.evaluate((id) => {
          const p = document.getElementById(id);
          const r = p.getBoundingClientRect();
          return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, panelOverflow: p.scrollWidth - p.clientWidth,
            clipped: [...p.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width && n.getBoundingClientRect().right > r.right + 2).slice(0, 10).map((n) => n.id || n.className),
            header: [...document.querySelectorAll(".nav > .brand, .nav-utilities > *, .nav-mobile-menu > summary")].filter((n) => n.getBoundingClientRect().width).map((n) => ({ name: n.id || n.className, left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right, height: n.getBoundingClientRect().height }))
          };
        }, id);
        report.viewports.push({ route, ...sample });
        if (["top", "play", "bots", "puzzles", "tutorial", "game-review", "friends", "login", "store", "settings", "leaderboards", "plan"].includes(route)) {
          await page.screenshot({ path: path.join(output, `${route}-${width}.png`), animations: "disabled" });
        }
      }
    }
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    // Real failed module request followed by the visible recovery control.
    await page.close();
    const retryPage = await context.newPage();
    let attempts = 0;
    await retryPage.route("**/assets/routes/settings.js*", (route) => {
      attempts += 1;
      return attempts === 1 ? route.fulfill({ status: 503, body: "Temporary failure" }) : route.continue();
    });
    await retryPage.goto(`${origin}/#settings`, { waitUntil: "load" });
    await retryPage.waitForTimeout(1000);
    console.log("Recovery state", attempts, await retryPage.locator('[data-route-status]').evaluateAll((nodes) => nodes.map((n) => ({ status: n.dataset.routeStatus, text: n.textContent }))));
    const failure = retryPage.locator('#settings [data-route-status]');
    await failure.waitFor();
    await failure.getByRole("button", { name: "Retry section" }).click();
    await retryPage.waitForTimeout(600);
    report.routeRecovery = { requests: attempts, failureStillVisible: await failure.isVisible() };
    let configRequests = 0;
    await context.route("**/api/auth-config", (route) => {
      configRequests += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://synthetic.invalid", anonKey: "synthetic-not-a-credential", authRedirectOrigins: [origin] }) });
    });
    const guest = await context.newPage();
    await guest.goto(`${origin}/#login`, { waitUntil: "load" });
    await guest.waitForFunction(() => document.documentElement.dataset.authState === "guest", null, { timeout: 10000 });
    await guest.evaluate(() => { location.hash = "#store"; });
    await guest.locator("#store").waitFor({ state: "visible" });
    report.guestHydration = { state: await guest.locator("html").getAttribute("data-auth-state"), configRequests };
    await context.close();
    // Real CacheStorage + service-worker install/activation, not a simulated SW.
    const offline = await browser.newContext({ serviceWorkers: "allow" });
    await offline.route("https://**/*", (route) => route.abort());
    const probe = await offline.newPage();
    await probe.goto(`${origin}/__cache_probe`);
    await probe.evaluate(async () => {
      const old = await caches.open("nschess-shell-v192-daily-puzzle-ux-perf");
      await old.put("/assets/routes/settings.js", new Response("stale optional module"));
      await navigator.serviceWorker.register("/service-worker.js");
      await navigator.serviceWorker.ready;
    });
    await probe.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const cacheKeys = await probe.evaluate(() => caches.keys());
    const moduleText = await probe.evaluate(() => fetch("/assets/routes/settings.js").then((r) => r.text()));
    const goodShell = await probe.evaluate(() => fetch("/assets/app.css?v=cache-probe").then((r) => r.text()));
    failShell = true;
    const badNetworkShell = await probe.evaluate(() => fetch("/assets/app.css?v=cache-probe").then((r) => r.text()));
    await offline.setOffline(true);
    const offlineShell = await probe.evaluate(() => fetch("/assets/app.css?v=cache-probe").then((r) => r.text()));
    report.cacheRecovery = { cacheKeys, oldOptionalModuleRejected: moduleText !== "stale optional module", httpFailurePreservesShell: badNetworkShell === goodShell, offlinePreservesShell: offlineShell === goodShell };
    await offline.close();
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, startup: { ...report.startup, resources: report.startup.resources.length }, viewports: report.viewports.filter((v) => v.overflow > 1 || v.panelOverflow > 1) }, null, 2));
    if (!label.startsWith("before")) {
      assert.deepEqual(report.errors, []);
      assert.ok(report.viewports.every((v) => v.overflow <= 1), "all inspected routes fit the viewport");
      assert.ok(report.viewports.every((v) => v.panelOverflow <= 1), "route contents are not silently clipped");
      for (const sample of report.viewports.filter((v) => v.route !== "top" && v.width <= 390)) {
        assert.ok(sample.header.every((item) => item.height >= 44 && item.right - item.left >= 44), "inner-page mobile header targets stay 44px");
        for (let i = 1; i < sample.header.length; i++) assert.ok(sample.header[i].left >= sample.header[i - 1].right, "header controls do not overlap");
      }
      assert.ok(attempts >= 2, "Retry really re-fetches the failed module");
      assert.equal(report.routeRecovery.failureStillVisible, false, "route recovers after a transient failure");
      assert.equal(report.cacheRecovery.oldOptionalModuleRejected, true);
      assert.equal(report.cacheRecovery.httpFailurePreservesShell, true);
      assert.equal(report.cacheRecovery.offlinePreservesShell, true);
      assert.ok(!cacheKeys.includes("nschess-shell-v192-daily-puzzle-ux-perf"));
      assert.equal(report.guestHydration.state, "guest");
      assert.equal(configRequests, 1, "successful configuration remains shared across guest routes");
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
