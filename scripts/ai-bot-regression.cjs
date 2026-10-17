const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.setTimeout(1000, () => request.destroy());
      request.on("error", retry);
    };
    const retry = () => {
      if (server.exitCode !== null || server.signalCode !== null || Date.now() - started > 15000) reject(new Error("AI bot test server did not start."));
      else setTimeout(check, 100);
    };
    check();
  });
}

const fakeWorkerInit = `
(() => {
  const probe = window.__phase3WorkerProbe = { created: 0, terminated: 0, live: 0, go: [], commands: [], lateDeliveries: 0, timeline: [], readyAcks: 0 };
  window.Worker = class FakeStockfishWorker {
    constructor(url) {
      this.url = String(url);
      this.id = ++probe.created;
      this.terminated = false;
      probe.live += 1;
    }
    deliver(data, delay = 0) {
      setTimeout(() => {
        if (this.terminated) probe.lateDeliveries += 1;
        probe.timeline.push({ time: performance.now(), direction: "out", data: String(data) });
        this.onmessage?.({ data });
      }, delay);
    }
    postMessage(raw) {
      const command = String(raw);
      probe.commands.push({ worker: this.id, command });
      probe.timeline.push({ time: performance.now(), direction: "in", data: command });
      if (command === "uci") this.deliver("id name Deterministic Test Worker\\nuciok");
      else if (command === "isready") {
        probe.readyAcks += 1;
        // The second acknowledgement belongs to move configuration. Keep it
        // pending longer than the former move budget to prove that budget
        // starts at the search command, not while the UCI handshake is in flight.
        this.deliver("readyok", probe.readyAcks === 2 ? 4000 : 0);
      }
      else if (command.startsWith("go ")) {
        const index = probe.go.length + 1;
        probe.go.push({ worker: this.id, command, index });
        this.deliver("bestmove e7e5", index === 1 || index === 3 ? 1350 : 100);
      }
    }
    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      probe.terminated += 1;
      probe.live -= 1;
    }
  };
})();`;

const failingWorkerInit = `
(() => {
  const probe = window.__phase3WorkerProbe = { created: 0, terminated: 0, live: 0 };
  window.Worker = class FailingStockfishWorker {
    constructor() { probe.created += 1; probe.live += 1; }
    postMessage(command) { if (String(command) === "uci") setTimeout(() => this.onerror?.({ message: "deterministic engine failure" }), 0); }
    terminate() { probe.terminated += 1; probe.live -= 1; }
  };
})();`;

async function newContext(browser, { fakeWorker = false, failingWorker = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await context.route("https://**/*", (route) => route.abort());
  await installOfflineSupabaseFixture(context);
  await installOptionalCdnFixtures(context);
  if (fakeWorker) await context.addInitScript({ content: fakeWorkerInit });
  if (failingWorker) await context.addInitScript({ content: failingWorkerInit });
  return context;
}

async function openBots(page, baseUrl) {
  await page.goto(`${baseUrl}/#bots`, { waitUntil: "domcontentloaded" });
  if (await page.locator("#firstVisitSetup").isVisible()) await page.locator("#firstVisitSetupLater").click();
  await page.locator("#aiBotRoster [data-ai-bot-play]").first().waitFor({ state: "visible", timeout: 15000 });
}

async function startBot(page, botId) {
  const startedAt = Date.now();
  const rosterButton = page.locator(`#aiBotRoster [data-ai-bot-play="${botId}"]`);
  if (!await rosterButton.isVisible()) {
    await page.locator('.site-header a[data-site-tab="bots"]').first().click();
    await page.waitForFunction(() => location.hash === "#bots", null, { timeout: 5000 });
  }
  await rosterButton.click();
  await page.locator("#aiGameReady").waitFor({ state: "visible", timeout: 10000 });
  await page.locator('#aiGameReady [data-ai-game-ready-pace="none"]').click();
  await page.locator("#aiGameReadyStart").click();
  await page.waitForFunction(() => document.getElementById("play")?.classList.contains("is-active-game")
    && document.querySelectorAll("#coachBoard [data-square]").length === 64, null, { timeout: 15000 });
  return startedAt;
}

async function playE4(page) {
  const startedAt = Date.now();
  await page.locator('#coachBoard [data-square="e2"]').click();
  await page.locator('#coachBoard [data-square="e4"]').click();
  await page.waitForFunction(() => document.querySelector('#coachBoard [data-square="e4"]')?.getAttribute("aria-label")?.includes("white pawn"), null, { timeout: 5000 });
  return startedAt;
}

async function historyText(page) {
  return (await page.locator("#moveHistory").textContent())?.replace(/\s+/g, " ").trim() || "";
}

async function main() {
  const port = await findPort();
  const env = { E2E_PORT: String(port) };
  for (const [name, value] of Object.entries(process.env)) {
    if (["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(name.toUpperCase())) env[name] = value;
  }
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], { cwd: root, env, stdio: "ignore" });
  let browser;
  const pageErrors = [];
  const results = {};
  try {
    await waitForServer(port, server);
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    const baseUrl = `http://127.0.0.1:${port}`;
    const context = await newContext(browser, { fakeWorker: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openBots(page, baseUrl);
    const rosterCount = await page.locator("#aiBotRoster [data-ai-bot-play]").count();
    assert.equal(rosterCount, 38, "all 38 ordered bot profiles are available");
    const rosterText = await page.locator("#bots").innerText();
    assert.doesNotMatch(rosterText, /\b\d{3,4}\s*Elo\b/i, "roster does not claim calibrated bot ratings");
    assert.match(rosterText, /Level 1 · Beginner/);
    assert.match(rosterText, /Level 38 · Master/);
    const botControlLabels = await page.locator("#aiBotRoster [data-ai-bot-play]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    assert.equal(new Set(botControlLabels).size, 38, "each bot has a distinct accessible ordinal level label");
    assert.match(botControlLabels[0], /practice level 1 of 38, Beginner/i);
    assert.match(botControlLabels[37], /practice level 38 of 38, Master/i);
    assert.deepEqual(await page.locator("#aiBotSort option").evaluateAll((options) => options.map((option) => option.value)), ["difficulty-asc", "difficulty-desc", "name"], "roster sorting uses practice difficulty rather than unsupported rating labels");
    const responsive = [];
    for (const width of [390, 375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const sample = await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll("#aiBotRoster .ai-bot-card")].filter((card) => card.getBoundingClientRect().width > 0).length }));
      assert.ok(sample.cards > 0, `bot cards remain visible at ${width}px`);
      assert.ok(sample.pageWidth <= width + 1, `bot roster does not overflow at ${width}px`);
      responsive.push(sample);
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await startBot(page, "bot-pebble");
    assert.equal(await page.evaluate(() => window.__phase3WorkerProbe.created), 0, "local practice does not initialize Stockfish");
    assert.match(await page.locator("#aiPlayerStatus").textContent(), /Local practice/);
    assert.match(await page.locator('#aiPlayerCard [data-ai-stat="engine"]').textContent(), /Local practice model/);
    assert.equal(await page.locator('#aiPlayerCard [data-ai-stat="rating"]').textContent(), "Level 1 · Beginner");
    assert.equal(await page.locator('#aiPlayerCard [data-ai-stat="rating"]').evaluate((node) => node.previousElementSibling.textContent), "Practice level");
    await page.locator("#aiPlayerCard").click();
    assert.match(await page.locator("#gameCoach").textContent(), /not an Elo-calibrated opponent/i);
    const practiceStarted = await playE4(page);
    await page.waitForFunction(() => Boolean(document.querySelector("#moveHistory .move-pair")?.children?.[2]?.textContent?.trim()), null, { timeout: 5000 });
    const practiceReplyMs = Date.now() - practiceStarted;
    const { Chess } = await import(pathToFileURL(path.join(root, "assets", "vendor", "chess.js-1.0.0.mjs")).href);
    const practiceGame = new Chess();
    assert.ok(practiceGame.move("e4"), "human e4 is legal");
    const practiceSan = (await page.locator("#moveHistory .move-pair").first().locator(":scope > *").nth(2).textContent())?.trim();
    assert.ok(practiceSan && practiceGame.move(practiceSan), `local practice reply ${practiceSan} is legal`);

    await startBot(page, "bot-auric");
    assert.match(await page.locator("#aiPlayerRating").textContent(), /Level 38 · Master/);
    assert.match(await page.locator('#aiPlayerCard [data-ai-stat="engine"]').textContent(), /Stockfish/);
    await page.waitForFunction(() => window.__phase3WorkerProbe.created === 1
      && document.getElementById("aiPlayerStatus")?.textContent?.includes("Ready"), null, { timeout: 5000 });
    const fakeInitTimeline = await page.evaluate(() => window.__phase3WorkerProbe.timeline);
    const fakeUciStart = fakeInitTimeline.find((event) => event.direction === "in" && event.data === "uci");
    const fakeReady = fakeInitTimeline.find((event) => event.direction === "out" && /readyok/.test(event.data));
    assert.ok(fakeUciStart && fakeReady, "fake engine captures its actual UCI initialization handshake");
    const fakeEngineInitMs = Math.round(fakeReady.time - fakeUciStart.time);
    await playE4(page);
    await page.waitForFunction(() => window.__phase3WorkerProbe.go.length === 1, null, { timeout: 5000 });
    const pendingStatus = await page.locator("#aiPlayerStatus").textContent();
    assert.match(pendingStatus, /Thinking/i, "worker search is visibly pending before route cancellation");
    const firstWorker = await page.evaluate(() => window.__phase3WorkerProbe.go[0]);
    assert.match(firstWorker.command, /depth 15/);
    assert.match(firstWorker.command, /movetime 3000/);
    const engineCommands = await page.evaluate(() => window.__phase3WorkerProbe.commands.map((entry) => entry.command));
    const firstGoCommandIndex = engineCommands.findIndex((command) => command === firstWorker.command);
    assert.ok(firstGoCommandIndex >= 0 && !engineCommands.slice(0, firstGoCommandIndex).includes("stop"), "a slow ready handshake cannot consume the move-search timeout");
    assert.ok(engineCommands.includes("setoption name Skill Level value 20"), "level 38 maps to Stockfish skill 20/20");
    assert.ok(engineCommands.includes("setoption name UCI_LimitStrength value false"), "engine difficulty uses explicit skill/time, not an asserted Elo rating");
    assert.ok(engineCommands.includes("setoption name UCI_Elo value 1320"), "roster profiles do not inject their legacy Elo labels into the engine");
    await page.locator(".site-header [data-home-link]").first().click();
    await page.waitForFunction(() => location.hash === "#top" && !document.getElementById("play")?.classList.contains("is-active-panel"), null, { timeout: 5000 });
    await wait(1600);
    assert.equal(await locationHash(page), "#top");
    let historyWhileHome = await historyText(page);
    assert.doesNotMatch(historyWhileHome, /e5/i, "late engine reply cannot apply after leaving Play");
    const resumeReplyStarted = Date.now();
    await page.locator('.site-header a[data-site-tab="play"]').first().click();
    await page.waitForFunction(() => location.hash === "#play" && document.getElementById("play")?.classList.contains("is-active-panel"), null, { timeout: 5000 });
    await page.waitForFunction(() => window.__phase3WorkerProbe.go.length === 2, null, { timeout: 5000 });
    await page.waitForFunction(() => /e5/i.test(document.querySelector("#moveHistory .move-pair")?.textContent || ""), null, { timeout: 5000 });
    const engineReplyMs = Date.now() - resumeReplyStarted;
    const historyAfterResume = await historyText(page);
    assert.match(historyAfterResume, /e4.*e5/i, "returning to Play starts a fresh legal engine reply");

    await page.locator("#restartGame").click();
    await page.waitForFunction(() => document.getElementById("moveHistory")?.textContent?.trim() === "No moves yet.", null, { timeout: 5000 });
    await playE4(page);
    await page.waitForFunction(() => window.__phase3WorkerProbe.go.length === 3, null, { timeout: 5000 });
    assert.match(await page.locator("#aiPlayerStatus").textContent(), /Thinking/i);
    await page.locator("#restartGame").click();
    await page.waitForFunction(() => document.getElementById("moveHistory")?.textContent?.trim() === "No moves yet.", null, { timeout: 5000 });
    await wait(1500);
    const historyWhileRestarted = await historyText(page);
    assert.equal(historyWhileRestarted, "No moves yet.", "a response from the cancelled pre-restart worker cannot mutate a repeated initial position");
    assert.match(await page.locator('#coachBoard [data-square="e2"]').getAttribute("aria-label"), /white pawn/i);
    await playE4(page);
    await page.waitForFunction(() => window.__phase3WorkerProbe.go.length === 4, null, { timeout: 5000 });
    await page.waitForFunction(() => /e5/i.test(document.querySelector("#moveHistory .move-pair")?.textContent || ""), null, { timeout: 5000 });
    const workerState = await page.evaluate(() => ({ ...window.__phase3WorkerProbe }));
    assert.equal(workerState.created, 3, "worker count remains bounded across route and restart cancellation");
    assert.equal(workerState.terminated, 2, "cancelled searches release their worker");
    assert.equal(workerState.live, 1, "only the current worker remains live");
    assert.ok(workerState.lateDeliveries >= 2, "the fixture delivered both cancelled responses after worker termination");
    assert.deepEqual(pageErrors, [], "bot selection and stale-response cases produce no uncaught browser errors");
    console.log("AI bot roster, local practice, engine-required configuration, cancellation, and restart races passed.");
    results.roster = { count: rosterCount, responsive };
    results.localPractice = { engineWorkers: 0, legalReply: practiceSan, moveInputToReplyMs: practiceReplyMs };
    results.engineRequired = { level: await page.locator("#aiPlayerRating").textContent(), skill: 20, fakeEngineInitMs, fakeMoveCommand: firstWorker.command, replyAfterResume: historyAfterResume };
    results.lifecycle = { homeStayedActive: true, staleRouteMoveRejected: true, restartMoveRejected: true, workers: { created: workerState.created, terminated: workerState.terminated, live: workerState.live }, lateDeliveries: workerState.lateDeliveries, replyMs: engineReplyMs };
    await context.close();

    const failedContext = await newContext(browser, { failingWorker: true });
    const failedPage = await failedContext.newPage();
    failedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openBots(failedPage, baseUrl);
    await startBot(failedPage, "bot-auric");
    await playE4(failedPage);
    await failedPage.waitForFunction(() => document.getElementById("aiPlayerStatus")?.textContent?.includes("Engine unavailable")
      && document.getElementById("gameCoach")?.textContent?.includes("No weaker move was substituted"), null, { timeout: 10000 });
    assert.doesNotMatch(await historyText(failedPage), /e5/i, "engine-required bot does not silently downgrade when Stockfish fails");
    // Open the two nested native disclosures programmatically because the
    // live-game layout can place setup controls outside the viewport. The
    // actual Easy button click still runs its production event listener.
    const easyDifficulty = failedPage.locator('#play [data-game-difficulty="easy"]');
    await easyDifficulty.evaluate((button) => {
      button.closest("details.coach-difficulty-menu").open = true;
      button.closest("details.coach-setup").open = true;
      button.click();
    });
    try {
      await failedPage.waitForFunction(() => document.getElementById("aiPlayerStatus")?.textContent?.includes("Local fallback")
        && document.getElementById("gameCoach")?.textContent?.includes("lighter local fallback"), null, { timeout: 5000 });
    } catch (error) {
      console.error("Lower-level fallback diagnostic:", JSON.stringify(await failedPage.evaluate(() => ({
        difficulty: document.getElementById("gameDifficultyBadge")?.textContent?.trim(),
        status: document.getElementById("aiPlayerStatus")?.textContent?.trim(),
        coach: document.getElementById("gameCoach")?.textContent?.trim(),
        history: document.getElementById("moveHistory")?.textContent?.trim(),
        setupOpen: document.querySelector("#play .coach-setup")?.open,
        difficultyMenuOpen: document.querySelector("#play .coach-difficulty-menu")?.open,
        worker: window.__phase3WorkerProbe
      })), null, 2));
      throw error;
    }
    const fallbackHistory = await historyText(failedPage);
    const fallbackGame = new Chess();
    assert.ok(fallbackGame.move("e4"));
    const fallbackSan = fallbackHistory.match(/e4\s*([a-zA-Z0-9+#=]+)/)?.[1];
    assert.ok(fallbackSan && fallbackGame.move(fallbackSan), `disclosed easy fallback reply ${fallbackSan} is legal`);
    results.engineFailure = { strictFailureExplicit: true, noSilentDowngrade: true, selectedLowerLevelFallback: true, fallbackSan, fallbackHistory, workerAttempts: await failedPage.evaluate(() => window.__phase3WorkerProbe.created) };
    await failedContext.close();
    console.log("Engine failure remained explicit; no weaker move was substituted.");

    const realContext = await newContext(browser);
    await realContext.addInitScript({ content: `
(() => {
  const NativeWorker = window.Worker;
  const probe = window.__phase3NativeWorkerProbe = { created: 0, commands: [], messages: [], timeline: [], errors: [] };
  window.__phase3NativeWorkers = [];
  window.Worker = class ObservedWorker extends NativeWorker {
    constructor(...args) {
      super(...args);
      probe.created += 1;
      window.__phase3NativeWorkers.push(this);
      this.addEventListener("message", (event) => { const data = String(event.data || "").slice(0, 260); probe.messages.push(data); probe.timeline.push({ time: performance.now(), direction: "out", data }); if (probe.messages.length > 30) probe.messages.shift(); if (probe.timeline.length > 80) probe.timeline.shift(); });
      this.addEventListener("error", (event) => probe.errors.push(String(event.message || "worker error")));
    }
    postMessage(message, ...args) { const command = String(message); probe.commands.push(command); probe.timeline.push({ time: performance.now(), direction: "in", data: command }); if (probe.timeline.length > 80) probe.timeline.shift(); return super.postMessage(message, ...args); }
  };
})();` });
    const realPage = await realContext.newPage();
    realPage.on("pageerror", (error) => pageErrors.push(error.message));
    const realConsoleErrors = [];
    const realFailedRequests = [];
    realPage.on("console", (message) => { if (message.type() === "error") realConsoleErrors.push(message.text()); });
    realPage.on("requestfailed", (request) => realFailedRequests.push({ url: request.url(), error: request.failure()?.errorText || "failed" }));
    await openBots(realPage, baseUrl);
    await startBot(realPage, "bot-auric");
    await realPage.waitForFunction(() => document.getElementById("aiPlayerStatus")?.textContent?.includes("Ready"), null, { timeout: 20000 });
    const workerInitState = await realPage.evaluate(() => window.__phase3NativeWorkerProbe);
    assert.ok(workerInitState.messages.some((message) => /uciok/.test(message))
      && workerInitState.messages.some((message) => /readyok/.test(message)), "real Stockfish completed its UCI initialization handshake");
    const realUciStart = workerInitState.timeline.find((event) => event.direction === "in" && event.data === "uci");
    const realReady = workerInitState.timeline.find((event) => event.direction === "out" && /readyok/.test(event.data));
    assert.ok(realUciStart && realReady, "real Stockfish initialization timestamps are observable from Worker protocol");
    const realInitMs = Math.round(realReady.time - realUciStart.time);
    const messagesBeforeReadyProbe = workerInitState.messages.length;
    await realPage.evaluate(() => window.__phase3NativeWorkers[0]?.postMessage("isready"));
    await realPage.waitForFunction((before) => window.__phase3NativeWorkerProbe.messages.length > before
      && window.__phase3NativeWorkerProbe.messages.slice(before).some((message) => /readyok/.test(message)), messagesBeforeReadyProbe, { timeout: 5000 });
    const realReplyStarted = await playE4(realPage);
    try {
      await realPage.waitForFunction(() => Boolean(document.querySelector("#moveHistory .move-pair")?.children?.[2]?.textContent?.trim()), null, { timeout: 12000 });
    } catch (error) {
      console.error("Real Stockfish reply diagnostic:", JSON.stringify(await realPage.evaluate(() => ({
        history: document.getElementById("moveHistory")?.textContent?.trim() || "",
        status: document.getElementById("aiPlayerStatus")?.textContent?.trim() || "",
        coach: document.getElementById("gameCoach")?.textContent?.trim() || "",
        turn: document.getElementById("gameTurnBadge")?.textContent?.trim() || "",
        e4: document.querySelector('#coachBoard [data-square="e4"]')?.getAttribute("aria-label") || "",
        worker: window.__phase3NativeWorkerProbe,
        workerUrls: performance.getEntriesByType("resource").filter((entry) => /stockfish/i.test(entry.name)).map((entry) => entry.name)
      })), null, 2));
      console.error("Stockfish console/request failures:", JSON.stringify({ consoleErrors: realConsoleErrors, requests: realFailedRequests }, null, 2));
      throw error;
    }
    const realReplyMs = Date.now() - realReplyStarted;
    const realHistory = await historyText(realPage);
    const realSearchTimeline = await realPage.evaluate(() => window.__phase3NativeWorkerProbe.timeline);
    const realGo = realSearchTimeline.find((event) => event.direction === "in" && event.data.startsWith("go "));
    const realBestMove = realSearchTimeline.find((event) => event.direction === "out" && event.data.startsWith("bestmove "));
    const realStop = realSearchTimeline.find((event) => event.direction === "in" && event.data === "stop");
    assert.ok(realGo && realBestMove, "real Stockfish emitted a bestmove after the actual search command");
    const realSearchMs = Math.round(realBestMove.time - realGo.time);
    const realGame = new Chess();
    assert.ok(realGame.move("e4"));
    const realSan = (await realPage.locator("#moveHistory .move-pair").first().locator(":scope > *").nth(2).textContent())?.trim();
    assert.ok(realSan && realGame.move(realSan), `real Stockfish reply ${realSan} is legal`);
    results.realStockfish = { loaded: true, initializationMs: realInitMs, legalReply: realSan, moveInputToReplyMs: realReplyMs, engineSearchMs: realSearchMs, stopRequestedBeforeReply: Boolean(realStop && realStop.time < realBestMove.time), history: realHistory };
    await realContext.close();

    assert.deepEqual(pageErrors, [], "all bot paths finish without browser errors");
    console.log(JSON.stringify({ result: "PASS", results, pageErrors }, null, 2));
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

function locationHash(page) {
  return page.evaluate(() => location.hash);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
