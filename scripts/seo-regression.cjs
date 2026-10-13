"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { origin, pages, legalPages, home } = require("./seo-pages.cjs");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const inventory = [home, ...pages, ...legalPages];
const fileFor = (route) => path.join(dist, route.endsWith("/") ? route + "index.html" : route);
const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
function staticChecks() {
  const titles = new Set(), descriptions = new Set();
  for (const page of inventory) {
    const html = fs.readFileSync(fileFor(page.path), "utf8");
    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    assert.equal(canonicals.length, 1, page.path);
    assert.equal(canonicals[0][1], origin + page.path);
    assert.match(html, /<meta name="robots" content="index, follow"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/nschessn.vercel.app\/assets\/icons\/icon-512.png"/);
    assert.ok(html.includes(`<meta property="og:url" content="${origin + page.path}"`));
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    const description = html.match(/<meta name="description" content="([^"]+)"/)[1];
    assert.ok(!titles.has(title), "Duplicate title"); titles.add(title);
    assert.ok(!descriptions.has(description), "Duplicate description"); descriptions.add(description);
    if (page.hash) {
      assert.equal((html.match(/<h1\b/g) || []).length, 1);
      assert.ok(html.includes(`href="/#${page.hash}"`));
      assert.ok(Buffer.byteLength(html) < 16000, "Guide HTML budget");
      assert.equal((html.match(/<script\b(?![^>]*type="application\/ld\+json")/g) || []).length, 0, "Guides must render without app code");
      const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
      assert.deepEqual(data["@graph"].map((item) => item["@type"]), ["WebSite", "WebPage", "BreadcrumbList"]);
      assert.equal(data["@graph"][1].url, origin + page.path);
    }
    // Every shipped local link/resource must resolve; no silent SPA fallback.
    for (const [, reference] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|data:)/.test(reference)) continue;
      const url = new URL(reference.replace(/&amp;/g, "&"), origin + page.path);
      assert.ok(fs.existsSync(fileFor(url.pathname)), `Missing ${url.pathname} linked from ${page.path}`);
      if (page.hash && url.hash && url.pathname === "/" && url.hash !== "#top") {
        const id = url.hash.slice(1) === "game-review" ? "gameReview" : url.hash.slice(1);
        assert.ok(fs.readFileSync(fileFor("/"), "utf8").includes(`id="${id}"`), `Missing workspace: ${url.hash}`);
      }
    }
  }
  const xml = fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8");
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(urls, inventory.map((page) => origin + page.path));
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((url) => !/[?#]/.test(url)));
  const robots = fs.readFileSync(path.join(dist, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*\r?\nAllow: \/\r?\n/);
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  assert.doesNotMatch(robots, /Disallow: \/(?:assets|$)/m);
  for (const file of ["404.html", "offline.html"]) assert.match(fs.readFileSync(path.join(dist, file), "utf8"), /name="robots" content="noindex, follow"/);
  assert.equal(config.outputDirectory, "dist");
  assert.equal(config.buildCommand, "npm run build");
  for (const privateEntry of [".env", "supabase", "api", "tests", "index-backup.html"]) assert.ok(!fs.existsSync(path.join(dist, privateEntry)), `Private source leaked into static output: ${privateEntry}`);
  assert.deepEqual(fs.readFileSync(path.join(dist, ".well-known/assetlinks.json")), fs.readFileSync(path.join(root, ".well-known/assetlinks.json")));
  assert.ok(!config.rewrites, "Unknown routes must not rewrite to the app");
  assert.ok(config.redirects.some((rule) => rule.source === "/index.html" && rule.destination === "/" && rule.permanent));
  for (const page of pages) for (const alias of [page.path.slice(0, -1), page.path + "index.html"]) {
    assert.ok(config.redirects.some((rule) => rule.source === alias && rule.destination === page.path && rule.permanent), `Missing canonical redirect: ${alias}`);
  }
  for (const source of ["/api/:path*", "/data/:path*", "/offline.html", "/404.html"]) {
    assert.ok(config.headers.some((rule) => rule.source === source && rule.headers.some((header) => header.key === "X-Robots-Tag" && header.value === "noindex, nofollow")));
  }
  for (const key of ["code", "access_token", "refresh_token", "token", "error", "state", "challenge", "spectate", "tournament"]) {
    assert.ok(config.headers.some((rule) => rule.source === "/" && rule.has?.[0].key === key && rule.headers.some((header) => header.key === "X-Robots-Tag")));
  }
  const shell = fs.readFileSync(fileFor("/"), "utf8");
  for (const id of ["login", "settings", "admin", "friends", "gameReview", "store", "leaderboards"]) assert.match(shell, new RegExp(`<section[^>]*id="${id}"[^>]*data-nosnippet`));
  assert.ok(fs.readFileSync(path.join(dist, "service-worker.js"), "utf8").includes('"./assets/search-metadata.js?v=seo-v1"'));
  console.log(`PASS: ${inventory.length} unique public metadata/canonical URLs, shipped links, sitemap inventory, robots, JSON-LD, noindex states and hosting configuration.`);
}
async function browserChecks() {
  const { chromium } = require("playwright");
  const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");
  const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".xml": "application/xml", ".txt": "text/plain", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
  // Filesystem server only. Vercel redirects/headers are asserted above; their
  // actual CDN behavior needs a deployment, which this mission does not make.
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = fileFor(pathname);
    if (!file.startsWith(dist + path.sep)) return response.writeHead(403).end();
    fs.readFile(file, (error, body) => {
      if (error) return response.writeHead(404, { "Content-Type": "text/html" }).end(fs.readFileSync(path.join(dist, "404.html")));
      response.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const artifacts = path.join(root, "e2e-artifacts/seo");
  fs.mkdirSync(artifacts, { recursive: true });
  const report = { publicUrls: inventory.map((page) => page.path), layouts: [], performance: {}, limitations: "Local Chromium; no production CDN redirect test or field Core Web Vitals measurement." };
  try {
    const nojs = await browser.newContext({ javaScriptEnabled: false });
    await nojs.route("https://**/*", (route) => route.abort());
    const page = await nojs.newPage();
    for (const entry of inventory) {
      const response = await page.goto(base + entry.path);
      assert.equal(response.status(), 200);
      assert.ok(await page.locator("h1").first().isVisible(), entry.path);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), origin + entry.path);
      if (!entry.hash) continue;
      for (const width of [320, 390, 768, 1366]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow ${entry.path} at ${width}`);
        assert.equal(await page.locator("article h2").count(), 4);
        const bounds = await page.locator(".hero .button").boundingBox();
        assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
        report.layouts.push({ path: entry.path, width, overflow: false });
        if (entry.path === "/learn/" && [390, 1366].includes(width)) await page.screenshot({ path: path.join(artifacts, `learn-${width}.png`), fullPage: true });
      }
    }
    await page.goto(base + "/learn/");
    await page.locator('.related a[href="/puzzles/"]').click();
    assert.match(page.url(), /\/puzzles\/$/);
    await page.goBack(); assert.match(page.url(), /\/learn\/$/);
    await page.reload(); assert.ok(await page.locator("h1").isVisible());
    assert.equal((await page.goto(base + "/missing-seo-page")).status(), 404);
    assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex, follow");
    await nojs.close();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    // Navigation is tested after onboarding. Its existing delayed dialog can
    // otherwise cover a home link halfway through a long multi-route run.
    await context.addInitScript(() => { localStorage.setItem("checkmateQuest.firstVisitSetup.v1", JSON.stringify({ done: true, skipped: true })); });
    const app = await context.newPage();
    const cdp = await context.newCDPSession(app);
    await app.addInitScript(() => {
      window.__seoMetrics = { lcp: 0, cls: 0 };
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__seoMetrics.lcp = entry.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__seoMetrics.cls += entry.value; }).observe({ type: "layout-shift", buffered: true });
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000 });
    await app.goto(base + "/learn/");
    await app.waitForTimeout(800);
    report.performance = await app.evaluate(() => ({ ...window.__seoMetrics, resources: performance.getEntriesByType("resource").map((item) => ({ path: new URL(item.name).pathname, bytes: item.transferSize })), domContentLoaded: performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd }));
    assert.ok(report.performance.lcp > 0 && report.performance.lcp < 2500, "Guide LCP lab budget");
    assert.ok(report.performance.cls < 0.1, "Guide CLS budget");
    assert.ok(report.performance.resources.every((item) => !/app\.js|stockfish|googleapis/.test(item.path)));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    const sitemapResponse = await app.request.get(base + "/sitemap.xml");
    const parsed = await app.evaluate((xml) => {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      return { errors: doc.querySelectorAll("parsererror").length, namespace: doc.documentElement.namespaceURI, urls: [...doc.querySelectorAll("loc")].map((item) => item.textContent) };
    }, await sitemapResponse.text());
    assert.equal(parsed.errors, 0); assert.equal(parsed.namespace, "http://www.sitemaps.org/schemas/sitemap/0.9");
    assert.deepEqual(parsed.urls, inventory.map((entry) => origin + entry.path));
    for (const entry of pages) {
      await app.goto(base + entry.path);
      await app.locator(".hero .button").click();
      const id = entry.hash === "game-review" ? "gameReview" : entry.hash;
      await app.locator(`#${id}.is-active-panel`).waitFor({ state: "visible" });
      assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    }
    for (const state of ["#login", "#settings", "#admin", "#friends", "#profile-synthetic", "#game-review", "#play?challenge=synthetic", "?code=synthetic#login", "#missing-workspace"]) {
      await app.goto(base + "/" + state);
      assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/, state);
      assert.equal(await app.locator('link[rel="canonical"]').getAttribute("href"), origin + "/");
      assert.doesNotMatch(await app.locator("head").textContent(), /synthetic/);
    }
    await app.goto(base + "/");
    for (const width of [320, 390, 768, 1366]) {
      await app.setViewportSize({ width, height: 844 });
      assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Home overflow at ${width}`);
    }
    await app.setViewportSize({ width: 390, height: 844 });
    const guideNav = app.locator('nav[aria-labelledby="home-guides-title"]');
    await guideNav.scrollIntoViewIfNeeded();
    await app.waitForFunction(() => {
      let element = document.querySelector('nav[aria-labelledby="home-guides-title"]');
      while (element) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) < 0.99 || style.visibility === "hidden") return false;
        element = element.parentElement;
      }
      return true;
    });
    await guideNav.screenshot({ path: path.join(artifacts, "home-guide-links-390.png") });
    const appErrors = [];
    app.on("pageerror", (error) => appErrors.push(error.message));
    await app.locator('#homeContinueLearningAction').click();
    await app.locator("#tutorial.is-active-panel").waitFor();
    assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    await app.goBack();
    assert.equal(await app.locator('meta[name="robots"]').getAttribute("content"), "index, follow");
    await app.goForward();
    assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    await app.goto(base + "/");
    await app.evaluate(() => { document.documentElement.dataset.authState = "authenticated"; });
    assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    await app.evaluate(() => { document.documentElement.dataset.authState = "guest"; });
    assert.equal(await app.locator('meta[name="robots"]').getAttribute("content"), "index, follow");
    await app.locator('#homeContinueLearningAction').click();
    assert.deepEqual(appErrors, []);
    await app.evaluate(() => navigator.serviceWorker.ready);
    await app.reload();
    await context.setOffline(true);
    await app.reload();
    assert.ok(await app.locator("#tutorial").count());
    assert.match(await app.locator('meta[name="robots"]').getAttribute("content"), /noindex/);
    await context.close();
    fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    console.log("PASS: real Chromium, 13 no-login/no-JS public pages, 36 responsive guide layouts, XML parsing, internal links, direct loads, all guide-to-workspace links, private fragment/query metadata, history navigation and offline metadata.");
    console.log(`Mobile lab: LCP ${Math.round(report.performance.lcp)} ms, CLS ${report.performance.cls}, 4x CPU / 100 ms latency / 200 KB/s. See e2e-artifacts/seo/report.json.`);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}
staticChecks();
if (!process.argv.includes("--static")) browserChecks().catch((error) => { console.error(error); process.exitCode = 1; });
