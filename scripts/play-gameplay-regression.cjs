const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");

async function findPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForServer(port, server) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (settled) return;
      const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        if (response.statusCode === 200) finish();
        else retry();
      });
      request.setTimeout(1000, () => request.destroy(new Error("Local Play test server readiness request timed out.")));
      request.on("error", retry);
    };
    const retry = () => {
      if (settled) return;
      if (server.playTestSpawnError) finish(new Error("Play gameplay test server failed to spawn.", { cause: server.playTestSpawnError }));
      else if (server.exitCode !== null || server.signalCode !== null || Date.now() - started > 15000) finish(new Error("Play gameplay test server did not start."));
      else setTimeout(check, 100);
    };
    server.on("error", (error) => { server.playTestSpawnError = error; retry(); });
    check();
  });
}

async function main() {
  const port = await findPort();
  const serverEnv = { E2E_PORT: String(port) };
  for (const [name, value] of Object.entries(process.env)) {
    if (["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(name.toUpperCase())) serverEnv[name] = value;
  }
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: serverEnv,
    stdio: ["ignore", "ignore", "ignore"]
  });
  let browser;
  try {
    await waitForServer(port, server);
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await context.route("https://**/*", (route) => route.abort());
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/#bots`, { waitUntil: "domcontentloaded" });
    if (await page.locator("#firstVisitSetup").isVisible()) await page.locator("#firstVisitSetupLater").click();
    await page.locator("#aiBotRoster [data-ai-bot-play]").first().click();
    await page.locator("#aiGameReady").waitFor({ state: "visible" });
    await page.locator('#aiGameReady [data-ai-game-ready-pace="10+0"]').click();
    await page.locator("#aiGameReadyStart").click();
    await page.waitForFunction(() => document.querySelectorAll("#coachBoard [data-square]").length === 64
      && document.getElementById("play")?.classList.contains("is-active-game"), null, { timeout: 15000 });
    const clockBefore = (await page.locator("[data-match-timer]").textContent())?.trim() || "";
    await page.waitForFunction((before) => document.querySelector("[data-match-timer]")?.textContent?.trim() !== before, clockBefore, { timeout: 4000 });
    const clockAfter = (await page.locator("[data-match-timer]").textContent())?.trim() || "";
    const clockSeconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    assert.match(clockBefore, /^\d+:\d{2}$/, "the active game displays a formatted clock");
    assert.ok(clockSeconds(clockAfter) < clockSeconds(clockBefore), `the active player's clock counts down (${clockBefore} → ${clockAfter})`);

    await page.evaluate(() => {
      const board = document.getElementById("coachBoard");
      const probe = { board, squares: [...board.querySelectorAll("[data-square]")], mutations: 0, squareMutations: 0, listenerAdds: 0, listenerRemoves: 0, longTasks: [] };
      probe.observer = new MutationObserver((records) => {
        probe.mutations += records.length;
        const squareRecords = records.filter((record) => {
          const changesRenderedState = record.type === "childList"
            || ["class", "aria-label", "data-aria-label"].includes(record.attributeName);
          return changesRenderedState && (record.target === board
            ? record.type === "childList"
            : record.target instanceof Element && Boolean(record.target.closest("[data-square]")));
        });
        probe.squareMutations += squareRecords.length;
      });
      probe.observer.observe(board, { subtree: true, childList: true, attributes: true, characterData: true });
      const addEventListener = EventTarget.prototype.addEventListener;
      const removeEventListener = EventTarget.prototype.removeEventListener;
      const isBoardInputTarget = (target) => target === board || target instanceof Element && target.matches("[data-square]");
      EventTarget.prototype.addEventListener = function (...args) {
        if (isBoardInputTarget(this)) probe.listenerAdds += 1;
        return addEventListener.apply(this, args);
      };
      EventTarget.prototype.removeEventListener = function (...args) {
        if (isBoardInputTarget(this)) probe.listenerRemoves += 1;
        return removeEventListener.apply(this, args);
      };
      try {
        probe.longTaskObserver = new PerformanceObserver((entries) => probe.longTasks.push(...entries.getEntries().map((entry) => ({
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
          attribution: [...(entry.attribution || [])].map((item) => ({ name: item.name, containerType: item.containerType, containerName: item.containerName, containerId: item.containerId }))
        }))));
        probe.longTaskObserver.observe({ type: "longtask", buffered: false });
      } catch {}
      window.__playGameProbe = probe;
    });
    const takeBoardMutations = () => page.evaluate(() => {
      const probe = window.__playGameProbe;
      probe.mutations += probe.observer.takeRecords().length;
      const count = probe.mutations;
      probe.mutations = 0;
      probe.squareMutations = 0;
      return count;
    });

    const initial = await page.evaluate(() => ({
      boardNodes: document.querySelectorAll("#coachBoard [data-square]").length,
      boardWidth: Math.round(document.getElementById("coachBoard").getBoundingClientRect().width),
      pageWidth: document.documentElement.scrollWidth,
      heapBytes: performance.memory?.usedJSHeapSize ?? null
    }));
    assert.equal(initial.boardNodes, 64, "an active Play game renders exactly 64 board squares");

    const selectionStarted = Date.now();
    await page.locator('#coachBoard [data-square="e2"]').click();
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e2"]')?.classList.contains("selected")
      && document.querySelectorAll("#coachBoard .legal, #coachBoard .capture").length > 0);
    const selectionMs = Date.now() - selectionStarted;
    const legalMovesHighlighted = await page.locator("#coachBoard .legal, #coachBoard .capture").count();
    await page.waitForTimeout(60);
    const selectionMutationRecords = await takeBoardMutations();
    const boardRenderKeyBeforeIllegalTap = await page.locator("#coachBoard").getAttribute("data-render-key");
    const positionBeforeIllegalTap = await page.locator('#coachBoard [data-square]').evaluateAll((squares) => squares.map((square) => square.getAttribute("aria-label")));

    await page.locator('#coachBoard [data-square="e5"]').click();
    await page.waitForFunction(() => document.getElementById("gameCoach")?.textContent.includes("not a legal destination"), null, { timeout: 3000 });
    const invalidTapSquareMutationRecords = await page.evaluate(() => window.__playGameProbe.squareMutations);
    const afterIllegalTap = await page.evaluate(() => ({
      selected: document.querySelector('#coachBoard [data-square="e2"]')?.classList.contains("selected") || false,
      legalIndicators: document.querySelectorAll("#coachBoard .legal, #coachBoard .capture").length,
      status: document.getElementById("gameCoach")?.textContent.trim() || ""
    }));
    const positionAfterIllegalTap = await page.locator('#coachBoard [data-square]').evaluateAll((squares) => squares.map((square) => square.getAttribute("aria-label")));
    const invalidTapSubtreeMutationRecords = await takeBoardMutations();
    assert.equal(afterIllegalTap.selected, true, "an illegal destination tap keeps the selected piece");
    assert.equal(afterIllegalTap.legalIndicators, legalMovesHighlighted, "an illegal destination tap keeps legal move hints visible");
    assert.match(afterIllegalTap.status, /not a legal destination/i, "the player gets specific illegal-destination feedback");
    assert.deepEqual(positionAfterIllegalTap, positionBeforeIllegalTap, "an illegal destination tap cannot change the rendered chess position");
    assert.equal(await page.locator("#coachBoard").getAttribute("data-render-key"), boardRenderKeyBeforeIllegalTap, "an illegal destination tap does not rerender the board");
    assert.equal(invalidTapSquareMutationRecords, 0, "an illegal destination tap does not redraw or rewrite board squares");

    const e4 = page.locator('#coachBoard [data-square="e4"]');
    if (!await page.locator('#coachBoard [data-square="e2"]').evaluate((square) => square.classList.contains("selected"))) {
      await page.locator('#coachBoard [data-square="e2"]').click();
    }
    await e4.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e4"]')?.classList.contains("legal"), null, { timeout: 5000 });
    assert.ok(await e4.evaluate((square) => square.classList.contains("legal")), "e4 is visibly marked as a legal destination");
    const moveStarted = Date.now();
    await e4.click();
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e4"]')?.getAttribute("aria-label")?.includes("white pawn")
      && document.querySelector('#coachBoard [data-square="e2"]')?.getAttribute("aria-label")?.includes("empty"));
    const moveRenderMs = Date.now() - moveStarted;
    const moveMutationRecords = await takeBoardMutations();
    const botStarted = Date.now();
    await page.waitForFunction(() => {
      const row = document.querySelector("#moveHistory .move-pair");
      return row?.children?.[2]?.textContent?.trim();
    }, null, { timeout: 15000 });
    const botReplyMs = Date.now() - botStarted;
    await page.waitForTimeout(100);
    const afterReply = await page.evaluate(() => {
      const probe = window.__playGameProbe;
      probe.mutations += probe.observer.takeRecords().length;
      return {
        blackReply: document.querySelector("#moveHistory .move-pair")?.children?.[2]?.textContent?.trim() || "",
        turn: document.getElementById("gameTurnBadge")?.textContent?.trim() || "",
        boardNodeCount: document.querySelectorAll("#coachBoard [data-square]").length,
        boardNodesStable: probe.squares.every((square) => square.isConnected
          && document.querySelector(`#coachBoard [data-square="${square.dataset.square}"]`) === square),
        boardMutationRecords: probe.mutations,
        botMutationRecords: probe.mutations + probe.observer.takeRecords().length,
        listenerAdds: probe.listenerAdds,
        listenerRemoves: probe.listenerRemoves,
        longTasks: probe.longTasks,
        heapBytes: performance.memory?.usedJSHeapSize ?? null
      };
    });
    assert.ok(afterReply.blackReply, "the local beginner bot replies after the human move");
    assert.match(afterReply.turn, /White to move/i, "the turn indicator returns to the player after the bot reply");
    assert.equal(afterReply.boardNodeCount, 64, "the move keeps the 64-square board intact");
    assert.equal(afterReply.boardNodesStable, true, "normal moves reuse the same square elements");
    await takeBoardMutations();

    await page.locator(".play-extra-actions summary").click();
    await page.waitForTimeout(650);
    await takeBoardMutations();
    const boardRenderKeyBeforeWhy = await page.locator("#coachBoard").getAttribute("data-render-key");
    const whyBefore = (await page.locator("#gameCoach").textContent())?.trim() || "";
    await page.locator("#whyGame").click();
    await page.waitForFunction((before) => document.getElementById("gameCoach")?.textContent.trim() !== before, whyBefore, { timeout: 3000 });
    const whyAfter = (await page.locator("#gameCoach").textContent())?.trim() || "";
    const whySquareMutationRecords = await page.evaluate(() => window.__playGameProbe.squareMutations);
    const whyMutationRecords = await takeBoardMutations();
    assert.notEqual(whyAfter, whyBefore, "Why updates the visible coach explanation");
    assert.ok(whyAfter, "Why leaves a visible explanation");
    assert.equal(await page.locator("#coachBoard").getAttribute("data-render-key"), boardRenderKeyBeforeWhy, "Why does not invoke a redundant board render");
    assert.equal(whySquareMutationRecords, 0, "Why updates the panel without redrawing board squares");

    const responsive = [];
    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(60);
      const sample = await page.evaluate(() => {
        const rect = document.getElementById("coachBoard")?.getBoundingClientRect();
        return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, boardWidth: Math.round(rect?.width || 0), boardHeight: Math.round(rect?.height || 0), boardRight: Math.round(rect?.right || 0) };
      });
      assert.ok(sample.boardWidth > 0 && sample.boardRight <= width + 1, `board fits at ${width}px`);
      assert.ok(Math.abs(sample.boardWidth - sample.boardHeight) <= 2, `board is square at ${width}px`);
      assert.ok(sample.pageWidth <= width + 1, `no horizontal overflow at ${width}px`);
      responsive.push(sample);
    }

    await page.locator("#undoGame").click();
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e2"]')?.getAttribute("aria-label")?.includes("white pawn")
      && document.querySelector('#coachBoard [data-square="e4"]')?.getAttribute("aria-label")?.includes("empty")
      && document.querySelector("#moveHistory")?.textContent?.trim() === "No moves yet."
      && document.querySelector("#gameCoach")?.textContent?.includes("Undo complete"), null, { timeout: 5000 });
    const undoMutationRecords = await takeBoardMutations();
    const afterUndo = await page.evaluate(() => ({
      history: document.getElementById("moveHistory")?.textContent?.trim() || "",
      turn: document.getElementById("gameTurnBadge")?.textContent?.trim() || "",
      coach: document.getElementById("gameCoach")?.textContent?.trim() || ""
    }));
    assert.equal(afterUndo.history, "No moves yet.", "undo refreshes the move history with the restored game state");
    assert.match(afterUndo.turn, /White to move/i, "undo refreshes whose turn it is");
    assert.match(afterUndo.coach, /Undo complete/i, "undo refreshes coach feedback");
    await page.locator("#restartGame").click();
    await page.waitForFunction(() => document.querySelector("#moveHistory")?.textContent?.trim() === "No moves yet."
      && document.querySelector('#coachBoard [data-square="e2"]')?.getAttribute("aria-label")?.includes("white pawn"), null, { timeout: 5000 });

    await page.setViewportSize({ width: 1366, height: 900 });
    const listenerBalance = () => page.evaluate(() => window.__playGameProbe.listenerAdds - window.__playGameProbe.listenerRemoves);
    const listenersBeforeNavigation = await listenerBalance();
    await page.locator('.site-header [data-home-link]').click();
    await page.waitForFunction(() => location.hash === "#top" && !document.getElementById("play")?.classList.contains("is-active-panel"), null, { timeout: 5000 });
    await page.locator('.site-header .nav-primary-link[href="#play"]').click();
    await page.waitForFunction(() => location.hash === "#play" && document.getElementById("play")?.classList.contains("is-active-panel"), null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e2"]')?.getAttribute("aria-label")?.includes("white pawn")
      && document.querySelector("#moveHistory")?.textContent?.trim() === "No moves yet.", null, { timeout: 5000 });
    const listenersAfterNavigation = await listenerBalance();
    assert.equal(listenersAfterNavigation, listenersBeforeNavigation, "Home→Play does not accumulate active board listeners");
    assert.equal(await page.locator("#coachBoard [data-square]").count(), 64, "returning to Play preserves the complete board");

    await page.locator('#coachBoard [data-square="e2"]').click();
    await page.locator('#coachBoard [data-square="e4"]').click();
    await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e4"]')?.getAttribute("aria-label")?.includes("white pawn"), null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector("#moveHistory .move-pair")?.children?.[2]?.textContent?.trim(), null, { timeout: 15000 });
    await page.locator("#restartGame").click();
    await page.waitForFunction(() => document.querySelector("#moveHistory")?.textContent?.trim() === "No moves yet."
      && document.querySelector('#coachBoard [data-square="e2"]')?.getAttribute("aria-label")?.includes("white pawn"), null, { timeout: 5000 });
    const listenersAfterSecondGame = await listenerBalance();
    assert.equal(listenersAfterSecondGame, listenersBeforeNavigation, "restarting a second game does not accumulate active board listeners");
    const heapAfterRepeatedGames = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);

    const noErrors = [...pageErrors];
    assert.deepEqual(noErrors, [], "a full AI game turn, undo and restart produce no uncaught errors");
    await context.close();
    console.log(JSON.stringify({ result: "PASS", initial, clock: { before: clockBefore, after: clockAfter }, selectionMs, legalMovesHighlighted, selectionMutationRecords, afterIllegalTap, invalidTapSubtreeMutationRecords, invalidTapSquareMutationRecords, moveRenderMs, moveMutationRecords, botReplyMs, afterReply, whyBefore, whyAfter, whyChanged: whyAfter !== whyBefore, whyMutationRecords, whySquareMutationRecords, responsive, afterUndo, undoMutationRecords, undoRestart: "PASS", navigationAndSecondGame: "PASS", listenerBalance: { afterReply: afterReply.listenerAdds - afterReply.listenerRemoves, afterNavigation: listenersAfterNavigation, afterSecondGame: listenersAfterSecondGame }, heapAfterRepeatedGames, pageErrors }, null, 2));
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      if (server.exitCode === null) {
        await new Promise((resolve) => {
          const finish = () => { server.removeListener("exit", finish); server.removeListener("error", finish); resolve(); };
          server.once("exit", finish);
          server.once("error", finish);
          if (!server.kill()) finish();
        });
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
