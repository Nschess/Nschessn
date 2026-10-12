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
  const baselineSha = process.env.MASTER_SOURCE_SHA || process.env.MASTER_COMPARE_SHA || "6c07f4fb7d3b4b698dcc410e443ff521ad5765f1";
  if (process.env.MASTER_MEASURE || process.env.MASTER_SOURCE_SHA) {
    assert.match(baselineSha, /^[a-f0-9]{40}$/);
    for (const name of ["index.html", "assets/app.js", "assets/app.css", "service-worker.js"]) {
      const source = execFileSync("git", ["show", `${baselineSha}:${name}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString("utf8");
      // Match the build's checkout line endings for comparable byte counts.
      baseSources.set(`/${name}`, fs.readFileSync(path.join(artifact, name), "utf8").includes("\r\n") ? source.replace(/\r?\n/g, "\r\n") : source);
    }
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/__cache_probe") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Local cache regression</title>");
    if (failShell && pathname === "/assets/app.css") return res.writeHead(503).end("Synthetic unavailable response");
    const sourcePath = pathname === "/" ? "/index.html" : pathname;
    if ((measureBaseline || process.env.MASTER_SOURCE_SHA) && baseSources.has(sourcePath)) return res.writeHead(200, { "Content-Type": mime[path.extname(sourcePath)], "Cache-Control": "no-store" }).end(baseSources.get(sourcePath));
    const file = path.resolve(artifact, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(artifact + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const report = { label, viewports: [], routes: [], states: [], errors: [] };
  const sizes = process.env.MASTER_SIZES
    ? process.env.MASTER_SIZES.split(',').map(raw => {
      const [width,height] = raw.split('x').map(Number);
      assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, `Invalid MASTER_SIZES: ${raw}`);
      return {width,height};
    })
    : (process.env.MASTER_WIDTHS?.split(',').map(Number) || [1366,980,768,390,375,320]).map(width=>({width,height:900}));
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
        samples.push({ source: measureBaseline ? baselineSha : "candidate", ...metrics });
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
    page.setDefaultTimeout(20000);
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
      if (route === "tutorial") await page.waitForFunction(() => document.querySelectorAll("#tutorialLessonList [data-tutorial-lesson-index]").length === 68);
      if (route === "puzzles") await page.waitForFunction(() => document.querySelectorAll("#realPuzzleBoard [data-square]").length === 64);
      await page.waitForTimeout(350);
      report.routes.push({ route, ms: Date.now() - start });
      for (const {width,height} of sizes) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(80);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const sample = await page.evaluate((id) => {
          const p = document.getElementById(id);
          const r = p.getBoundingClientRect();
          const board = p.querySelector('#tutorialBoard, #realPuzzleBoard, #coachBoard');
          const boardRect = board?.getBoundingClientRect();
          return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth, panelOverflow: p.scrollWidth - p.clientWidth,
            contentHeight: r.height, board: boardRect ? { top: boardRect.top, width: boardRect.width, height: boardRect.height } : null,
            clipped: [...p.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width && n.getBoundingClientRect().right > r.right + 2).slice(0, 10).map((n) => n.id || n.className),
            header: [...document.querySelectorAll(".nav > .brand, .nav-utilities > *, .nav-mobile-menu > summary")].filter((n) => n.getBoundingClientRect().width).map((n) => ({ name: n.id || n.className, left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right, height: n.getBoundingClientRect().height }))
          };
        }, id);
        report.viewports.push({ route, ...sample });
        if (process.env.MASTER_ALL_SCREENSHOTS || ["top", "play", "bots", "puzzles", "tutorial", "game-review", "friends", "login", "store", "settings", "leaderboards", "plan"].includes(route)) {
          await page.screenshot({ path: path.join(output, `${route}-${width}${process.env.MASTER_SIZES ? `x${height}` : ''}.png`), animations: "disabled" });
        }
      }
    }
    if (process.env.MASTER_ACTIVITIES) {
      const capture = async (name, boardSelector) => {
        if (process.env.MASTER_ACTIVITY_NAMES && !process.env.MASTER_ACTIVITY_NAMES.split(',').includes(name)) return;
        for (const {width,height} of sizes) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(120);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          const state = await page.evaluate((selector) => {
            const element = selector ? document.querySelector(selector) : null;
            const board = element?.getBoundingClientRect();
            const squares = element ? [...element.querySelectorAll('[data-square]')].map(square => square.getBoundingClientRect()) : [];
            return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth,
              nodes: document.querySelectorAll("*").length,
              board: board ? { top: board.top, width: board.width, height: board.height, scrollForFullBoard: Math.max(0,board.bottom-innerHeight), percent:board.width/innerWidth*100,
                usablePercent:board.width/(innerWidth-24)*100, squares:squares.length,
                contained:squares.every(r=>r.width>0 && r.height>0 && r.left>=board.left-1 && r.right<=board.right+1 && r.top>=board.top-1 && r.bottom<=board.bottom+1) } : null };
          }, boardSelector);
          report.states.push({ name, ...state });
          // Full-page capture can temporarily expand the layout viewport and
          // change vh/landscape sizing. Keep activity evidence at the tested
          // viewport, then capture the board at a usable scroll position.
          await page.screenshot({ path: path.join(output, `${name}-${width}${process.env.MASTER_SIZES ? `x${height}` : ''}.png`), animations: "disabled" });
          if (!label.startsWith("before")) {
            assert.ok(state.overflow <= 1, `${name} fits at ${width}`);
            if (['notifications-dialog','search-dialog'].includes(name)) {
              const close = page.locator(name === 'notifications-dialog' ? '#siteNotificationsClose' : '#siteSearchClose');
              const target = await close.evaluate(el=>{
                const r=el.getBoundingClientRect();
                return {width:r.width,height:r.height,reachable:el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
              });
              assert.ok(target.width>=44 && target.height>=44 && target.reachable,`${name} close is an unobstructed 44px target at ${width}x${height}: ${JSON.stringify(target)}`);
            }
            if (state.board) {
              assert.ok(Math.abs(state.board.width - state.board.height) <= 1, `${name} board stays square`);
              assert.equal(state.board.squares,64,`${name} contains 64 mounted squares`);
              assert.equal(state.board.contained,true,`${name} squares are not clipped by the board`);
              if (width<=430 && height>width && (['daily-active','lesson-active','play-active'].includes(name) || name.startsWith('puzzle-'))) {
                assert.ok(state.board.usablePercent>=90,`${name} uses at least 90% of safe phone content width`);
              }
              await page.locator(boardSelector).evaluate(el=>{
                const header=document.querySelector('.site-header')?.getBoundingClientRect();
                window.scrollTo({top:scrollY+el.getBoundingClientRect().top-Math.max(8,(header?.bottom || 0)+8),behavior:'instant'});
              });
              const visibility = await page.locator(boardSelector).evaluate(el=>{
                const hidden=[...el.querySelectorAll('[data-square]')].filter(square=>{
                  const r=square.getBoundingClientRect(), x=(r.left+r.right)/2, y=(r.top+r.bottom)/2;
                  const hit=document.elementFromPoint(x,y);
                  return !(x>=0 && y>=0 && x<innerWidth && y<innerHeight && hit && square.contains(hit));
                }).map(square=>{const r=square.getBoundingClientRect();return {square:square.dataset.square,top:r.top,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.className}});
                const r=el.getBoundingClientRect();
                return {visible:hidden.length===0,board:[r.top,r.width,r.height],viewport:[innerWidth,innerHeight],headerBottom:document.querySelector('.site-header')?.getBoundingClientRect().bottom,hidden:hidden.slice(0,4)};
              });
              state.visibility=visibility;
              fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
              assert.equal(visibility.visible,true,`${name} all 64 square centers usable at ${width}x${height}: ${JSON.stringify(visibility)}`);
              await page.screenshot({path:path.join(output,`${name}-${width}x${height}-board.png`),animations:'disabled'});
            }
          }
        }
      };
      await page.goto(`${origin}/#puzzles`);
      await page.waitForFunction(() => document.querySelectorAll("#realPuzzleBoard [data-square]").length === 64);
      await page.locator('[data-daily-puzzle-launch]').click();
      await page.locator('#dailyPuzzleBoard [data-square]').first().waitFor();
      await capture("daily-active", "#dailyPuzzleBoard");
      for (const mode of ["Trainer", "Rush", "Streak", "Battle"]) {
        await page.locator(`[data-real-mode="${mode}"]`).click();
        await capture(`puzzle-${mode.toLowerCase()}`, "#realPuzzleBoard");
      }
      await page.goto(`${origin}/#tutorial`);
      await page.waitForFunction(() => document.querySelectorAll("#tutorialBoard [data-square]").length === 64);
      await capture("lesson-active", "#tutorialBoard");
      // Additional real mounted training boards; no remote account operations.
      await page.goto(`${origin}/#openings`);
      await page.waitForFunction(() => document.querySelectorAll('#openingExplorerBoard [data-square]').length === 64);
      await capture('opening-explorer', '#openingExplorerBoard');
      await page.goto(`${origin}/#adventures`);
      await page.waitForFunction(() => document.querySelectorAll('#adventureBoard [data-square]').length === 64);
      await capture('adventure-active', '#adventureBoard');
      await page.goto(`${origin}/#tutorial`);
      if (await page.locator('#tutorialLibrary').count()) {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForFunction(() => !document.getElementById('tutorialLibrary').open);
        await page.locator('#tutorialLibrary summary').press("Enter");
        assert.equal(await page.locator('#tutorialTopicFilter').isVisible(), true, "keyboard opens the complete lesson library");
        await page.locator('#tutorialTopicFilter').selectOption("Tactics");
        assert.ok(await page.locator('[data-tutorial-lesson-index]').count() < 68);
        await page.locator('#tutorialLessonList [data-tutorial-lesson-index]').first().press("Enter");
        assert.equal(await page.locator('#tutorialLibrary').evaluate(el => el.open), false);
        assert.equal(await page.evaluate(() => document.getElementById('tutorialBoard').contains(document.activeElement)), true, "choosing a lesson restores visible board keyboard focus");
      }
      await page.goto(`${origin}/#play?mode=friend`);
      await page.locator('#play').waitFor({ state: "visible" });
      await capture("friendly-challenge");
      await page.goto(`${origin}/#bots`);
      await page.locator('[data-ai-bot-play="bot-pebble"]').click();
      await page.locator('#aiGameReady').waitFor({ state: "visible" });
      await capture("bot-ready-dialog");
      await page.locator('[data-ai-game-ready-pace="none"]').click();
      await page.locator('#aiGameReadyStart').click();
      await page.locator('#play.is-active-game').waitFor();
      await capture("play-active", "#coachBoard");
      await page.goto(`${origin}/#settings`);
      await page.locator('#settings').waitFor({ state: "visible" });
      await page.locator('#siteNotificationsOpen').click();
      await page.locator('#siteNotificationsDialog').waitFor({ state: "visible" });
      await capture("notifications-dialog");
      await page.locator('#siteNotificationsClose').click();
      await page.locator('#siteSearchOpen').click();
      await page.locator('#siteSearchDialog').waitFor({ state: "visible" });
      await capture("search-dialog");
      await page.locator('#siteSearchInput').press("Escape");
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
    // A prior page's scheduled auth retry must not contaminate the next
    // page's configuration-request measurement.
    await retryPage.close();
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
      for (const sample of report.viewports.filter((v) => v.width <= 390)) {
        assert.ok(sample.header.every((item) => item.height >= 44 && item.right - item.left >= 44), "Home and inner-page mobile header targets stay 44px");
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
