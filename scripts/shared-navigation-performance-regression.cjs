const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"]
]);

function startServer() {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
    catch { response.writeHead(400).end(); return; }
    if (pathname === "/") pathname = "/index.html";
    const file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    fs.stat(file, (statError, stat) => {
      const target = !statError && stat.isDirectory() ? path.join(file, "index.html") : file;
      fs.readFile(target, (error, content) => {
        if (error) { response.writeHead(404).end("Not found"); return; }
        response.writeHead(200, { "Content-Type": mime.get(path.extname(target)) || "application/octet-stream", "Cache-Control": "no-cache" });
        response.end(content);
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const { chromium } = require("playwright");
  const verbose = process.env.SHARED_NAV_VERBOSE === "1";
  const app = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const navigationStarted = Date.now();
    await page.goto(`${origin}/#top`, { waitUntil: "domcontentloaded" });
    await page.locator("#top").waitFor({ state: "visible" });
    const firstUsableMs = Date.now() - navigationStarted;
    await page.waitForTimeout(700);
    if (await page.locator("#firstVisitSetup").isVisible()) await page.locator("#firstVisitSetupLater").click();
    await page.locator("#firstVisitSetup").waitFor({ state: "hidden", timeout: 3000 });
    const shell = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const local = performance.getEntriesByType("resource").filter((entry) => new URL(entry.name).origin === location.origin);
      return {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadEventMs: Math.round(nav.loadEventEnd),
        requests: local.length,
        decodedBytes: local.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        dailyLoadedBeforeOpen: local.some((entry) => /daily-puzzle\.mjs|daily-puzzles-original/.test(entry.name)),
        nodeCount: document.getElementsByTagName("*").length,
        heapBytes: performance.memory?.usedJSHeapSize ?? null
      };
    });
    assert.equal(shell.dailyLoadedBeforeOpen, false, "Daily interaction code and catalog stay lazy until requested");

    const routeTimes = [];
    const go = async (route) => {
      const routeStarted = Date.now();
      if (verbose) console.log(`[route] ${route} start`);
      const selector = route === "home" ? "[data-home-link]" : `[data-site-tab="${route}"]`;
      const before = await page.evaluate(() => performance.now());
      await page.locator(selector).first().click({ timeout: 10000 });
      await page.waitForFunction((expected) => {
        const panelId = expected === "home" ? "top" : expected;
        const panel = document.getElementById(panelId);
        return panel && !panel.hidden && (expected === "home" ? !document.body.classList.contains("site-tab-mode") : document.body.classList.contains("site-tab-mode"));
      }, route, { timeout: 10000 });
      const transitionMs = Math.round((await page.evaluate(() => performance.now())) - before);
      await page.waitForTimeout(100);
      const routeDOM = await page.evaluate(() => {
        const ids = ["top", "play", "bots", "puzzles", "tutorial"];
        return {
          total: document.getElementsByTagName("*").length,
          panels: Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.querySelectorAll("*").length ?? 0]))
        };
      });
      routeTimes.push({ route, ms: transitionMs, ...routeDOM });
      if (verbose) console.log(`[route] ${route} ready in ${Date.now() - routeStarted}ms`);
    };

    for (const route of ["play", "bots", "puzzles", "tutorial", "home"]) await go(route);
    // Route modules and their first-use controls are intentionally lazy. Let
    // those one-time insertions finish before measuring repeat navigation.
    await page.waitForTimeout(2500);
    const domVitals = () => page.evaluate(() => ({
      nodeCount: document.getElementsByTagName("*").length,
      trainerNotes: document.querySelectorAll(".trainer-note").length,
      emptyPlaceholders: document.querySelectorAll(".home-lower-empty").length,
      routeStyles: [...document.querySelectorAll("link[data-route-style]")].map((link) => link.dataset.routeStyle).sort(),
      routeFailures: document.querySelectorAll("[data-route-status]").length
    }));
    const warmDOM = await domVitals();
    const warmNodeCount = warmDOM.nodeCount;
    const warmHeapBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const routeSequence = ["play", "bots", "puzzles", "tutorial", "home"];
    for (const route of routeSequence) await go(route);
    await page.waitForTimeout(1000);
    const firstRepeatDOM = await domVitals();
    const firstRepeatNodeCount = firstRepeatDOM.nodeCount;
    for (const route of routeSequence) await go(route);
    await page.waitForTimeout(1000);
    const steadyDOM = await domVitals();
    const steady = { nodeCount: steadyDOM.nodeCount, heapBytes: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null) };
    await go("play");
    await page.waitForTimeout(500);
    if (verbose) console.log("[route] measuring repeated-current clicks");
    const repeatedRouteNodeCountBefore = await page.evaluate(() => document.getElementsByTagName("*").length);
    await page.evaluate(() => {
      const observer = window.__refreshVisibleSectionObserver;
      const entrances = window.__refreshVisualEntrances;
      window.__sharedRouteProbe = { observerRefreshes: 0, entranceRefreshes: 0, observer, entrances };
      if (typeof observer === "function") window.__refreshVisibleSectionObserver = (...args) => {
        window.__sharedRouteProbe.observerRefreshes += 1;
        return observer(...args);
      };
      if (typeof entrances === "function") window.__refreshVisualEntrances = (...args) => {
        window.__sharedRouteProbe.entranceRefreshes += 1;
        return entrances(...args);
      };
    });
    const repeatHistoryBefore = await page.evaluate(() => history.length);
    const repeatRouteStarted = Date.now();
    const repeatedClickDurationsMs = [];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const clickStarted = Date.now();
      await page.locator('[data-site-tab="play"]').first().click();
      repeatedClickDurationsMs.push(Date.now() - clickStarted);
    }
    const repeatRouteElapsedMs = Date.now() - repeatRouteStarted;
    if (verbose) console.log("[route] repeated-current clicks complete");
    await page.waitForTimeout(1500);
    const repeatedCurrentRoute = await page.evaluate((historyBefore) => {
      const probe = window.__sharedRouteProbe;
      if (probe) {
        if (typeof probe.observer === "function") window.__refreshVisibleSectionObserver = probe.observer;
        if (typeof probe.entrances === "function") window.__refreshVisualEntrances = probe.entrances;
        delete window.__sharedRouteProbe;
      }
      return {
        historyEntriesAdded: history.length - historyBefore,
        observerRefreshes: probe?.observerRefreshes ?? null,
        entranceRefreshes: probe?.entranceRefreshes ?? null,
        nodeCount: document.getElementsByTagName("*").length,
        playPanelActive: document.getElementById("play")?.classList.contains("is-active-panel") ?? false,
        activeTabCount: document.querySelectorAll('[data-site-tab].is-active-tab').length,
        hash: location.hash
      };
    }, repeatHistoryBefore);
    await page.locator('[data-site-tab="puzzles"]').first().click();
    if (verbose) console.log("[daily] puzzles route open");
    await page.locator('[data-daily-puzzle-launch]').click();
    if (verbose) console.log("[daily] launch clicked");
    await page.locator("#dailyPuzzlePanel").waitFor({ state: "visible", timeout: 15000 });
    const responsiveResults = [];
    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const sample = await page.evaluate(() => {
        const board = document.getElementById("dailyPuzzleBoard");
        const rect = board?.getBoundingClientRect();
        return {
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          boardWidth: Math.round(rect?.width || 0),
          boardHeight: Math.round(rect?.height || 0),
          boardLeft: Math.round(rect?.left || 0),
          boardRight: Math.round(rect?.right || 0)
        };
      });
      responsiveResults.push(sample);
      assert.ok(sample.documentWidth <= sample.viewport + 1, `no horizontal overflow at ${width}px`);
      assert.ok(sample.boardWidth > 0 && sample.boardRight <= sample.viewport + 1, `puzzle board fits at ${width}px`);
      assert.ok(Math.abs(sample.boardWidth - sample.boardHeight) <= 2, `puzzle board remains square at ${width}px`);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const beforeDaily = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => /daily-puzzle\.mjs|daily-puzzles-original|chess\.js-1\.0\.0/.test(entry.name))
      .map((entry) => ({ path: new URL(entry.name).pathname, bytes: entry.decodedBodySize, ms: Math.round(entry.duration) })));
    const moveStarted = Date.now();
    const source = page.locator('#dailyPuzzleBoard button[draggable="true"]').first();
    await source.click({ timeout: 5000 });
    const destination = page.locator("#dailyPuzzleBoard button.legal[data-square]").first();
    await destination.waitFor({ state: "visible", timeout: 5000 });
    await destination.click({ timeout: 5000 });
    const moveMs = Date.now() - moveStarted;
    const finalBoard = await page.evaluate(() => ({
      moveFeedback: document.getElementById("dailyPuzzleFeedback")?.textContent || "",
      squareCount: document.querySelectorAll("#dailyPuzzleBoard button[data-square]").length
    }));

    const sorted = routeTimes.map((item) => item.ms).sort((a, b) => a - b);
    const report = {
      result: "PASS",
      firstUsableMs,
      shell,
      routeTransitionMedianMs: sorted[Math.floor(sorted.length / 2)],
      routeTransitionMaxMs: Math.max(...routeTimes.map((item) => item.ms)),
      routeTimes,
      warmNodeCount,
      warmDOM,
      firstRepeatNodeCount,
      firstRepeatDOM,
      steadyNodeCount: steady.nodeCount,
      steadyDOM,
      warmHeapBytes,
      steadyHeapBytes: steady.heapBytes,
      repeatedCurrentRoute: {
        clicks: 3,
        elapsedMs: repeatRouteElapsedMs,
        clickDurationsMs: repeatedClickDurationsMs,
        nodeCountBefore: repeatedRouteNodeCountBefore,
        ...repeatedCurrentRoute
      },
      dailyResourcesOnOpen: beforeDaily,
      responsiveResults,
      dailyMoveInteractionMs: moveMs,
      boardSquareCount: finalBoard.squareCount,
      dailyFeedback: finalBoard.moveFeedback,
      pageErrors
    };
    assert.equal(repeatedCurrentRoute.historyEntriesAdded, 0, "reselecting the active route does not add redundant history entries");
    assert.equal(repeatedCurrentRoute.observerRefreshes, 0, "reselecting the active route does not restart section observation");
    assert.equal(repeatedCurrentRoute.entranceRefreshes, 0, "reselecting the active route does not rescan visual entrances");
    assert.equal(repeatedCurrentRoute.nodeCount, repeatedRouteNodeCountBefore, "reselecting the active route does not change DOM size");
    assert.equal(repeatedCurrentRoute.playPanelActive, true, "reselecting the active route preserves the active panel");
    assert.equal(repeatedCurrentRoute.activeTabCount, 1, "reselecting the active route preserves one current navigation item");
    assert.equal(repeatedCurrentRoute.hash, "#play", "reselecting the active route preserves the route hash");
    assert.ok(moveMs > 0, "Daily board accepts a legal move through its controls");
    assert.ok(finalBoard.moveFeedback.trim().length > 0, "Daily board presents feedback after the move");
    assert.equal(finalBoard.squareCount, 64, "the board remains complete after a move");
    assert.deepEqual(pageErrors, [], "route changes and board interaction produce no uncaught page errors");
    assert.match(app, /function setupSiteTabs\(\)\s*\{\s*if \(setupSiteTabs\.ready\) return;/, "the global route listeners are guarded against duplicate setup");
    assert.match(app, /function initializeDeferredFeature\(name\)[\s\S]*?const existing = deferredFeaturePromises\.get\(name\)[\s\S]*?if \(existing\) return existing/, "route feature initialization is shared rather than repeated on each visit");
    assert.match(worker, /CACHE_NAME = "nschess-shell-v\d+-[^\"]+"/, "service worker uses a versioned cache for shell updates");
    assert.match(worker, /function savePublicAsset\(request, response\)[\s\S]*?cache\.put\(request, response\)[\s\S]*?MAX_OPTIONAL_ENTRIES/, "public runtime assets enter the bounded cache through the shared writer");
    assert.match(worker, /const isReviewShellAsset[\s\S]*?response\.clone\(\)[\s\S]*?savePublicAsset\(request, copy\)/, "shell asset responses are cloned and saved through the bounded cache path");

    console.log(JSON.stringify(report, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections?.();
    await closed;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
