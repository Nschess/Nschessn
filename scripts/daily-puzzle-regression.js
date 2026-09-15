/*
 * Local Daily Puzzle contract regression.
 *
 * This is an executable browser regression against the shipped app shell:
 * it uses an isolated offline Supabase fixture and a fixed local clock. No
 * credentials, network services, or persistent user state are involved.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.DAILY_PUZZLE_TEST_PORT || 4176);
const baseUrl = `http://127.0.0.1:${port}`;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (Date.now() - started > 15000) return reject(new Error("Daily Puzzle regression server did not start."));
      const request = http.get(`${baseUrl}/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else setTimeout(check, 50);
      });
      request.on("error", () => setTimeout(check, 50));
    };
    check();
  });
}

function staticContracts() {
  const html = read("index.html");
  const app = read("assets/app.js");
  const resolver = app.slice(app.indexOf("function getDailyPuzzleDateKey("), app.indexOf("function isDailyPuzzleRoute("));

  ["newToChessButton", "homeNextAction"].forEach((id) => {
    assert.match(html, new RegExp(`<a(?=[^>]*id="${id}")(?=[^>]*href="#puzzles\\?mode=daily")(?=[^>]*data-home-action="daily-puzzle")[^>]*>`),
      `${id} must open the canonical Daily Puzzle route.`);
  });
  assert.match(html, /id="homeBotsAction" href="#bots" data-site-tab="bots" data-site-panel="bots"/,
    "The board-free action rail must retain the Bots entry point.");
  assert.doesNotMatch(html, /\bid="(?:heroBoard|homePuzzlePreview|homePuzzleAction|homePuzzleTurn|homePuzzlePrompt)"/,
    "The homepage must not retain a Daily Puzzle preview surface.");
  assert.doesNotMatch(app, /function (?:getHomePuzzlePreview|buildHeroBoard|reportDailyPuzzleIdentity)\(/,
    "Hero-only Daily Puzzle rendering and diagnostics must be removed.");
  assert.doesNotMatch(resolver, /Math\.random\s*\(/,
    "Daily Puzzle selection must not use random selection.");
  assert.match(resolver, /function getDailyPuzzleOrdinal\(/,
    "Daily Puzzle selection must use a calendar-day ordinal.");
  assert.match(resolver, /getDailyPuzzleOrdinal\(dateKey\)[\s\S]*?% indexes\.length/,
    "Consecutive dates must progress deterministically through the verified catalogue.");
}

async function installFixedDate(context, isoDate) {
  await context.addInitScript((value) => {
    const NativeDate = Date;
    const fixedTime = new NativeDate(value).getTime();
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedTime]));
      }
      static now() { return fixedTime; }
    }
    FixedDate.parse = NativeDate.parse;
    FixedDate.UTC = NativeDate.UTC;
    window.Date = FixedDate;
  }, isoDate);
}

async function installHomeDefaults(context) {
  await context.addInitScript(() => {
    localStorage.setItem("checkmateQuest.firstVisitSetup.v1", JSON.stringify({ done: true, skipped: true }));
  });
}

async function captureBrowserCacheState(page) {
  return page.evaluate(async () => ({
    serviceWorkerRegistrations: "serviceWorker" in navigator
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
    cacheNames: "caches" in window ? await caches.keys() : []
  }));
}

async function captureDestination(page) {
  return page.evaluate(() => {
    const board = document.getElementById("realPuzzleBoard");
    const squares = [...(board?.querySelectorAll("[data-square]") || [])].map((square) => ({
      square: square.dataset.square || "",
      parity: square.classList.contains("light") ? "light" : square.classList.contains("dark") ? "dark" : "",
      piece: square.querySelector("[data-piece]")?.dataset.piece || ""
    }));
    return {
      puzzleId: board?.dataset.puzzleId || "",
      date: board?.dataset.dailyDate || "",
      sideToMove: board?.dataset.sideToMove || "",
      sourceSideToMove: board?.dataset.sourceSideToMove || "",
      sourceFen: board?.dataset.sourceFen || "",
      fen: board?.dataset.positionFen || "",
      catalogueSize: Number(window.checkmatePuzzleRuntime?.dailyCatalogueSize || 0),
      mode: board?.dataset.puzzleMode || "",
      squares
    };
  });
}

function assertSamePuzzle(actual, expected, message) {
  ["puzzleId", "date", "sourceFen", "sourceSideToMove", "sideToMove", "mode"].forEach((key) => {
    assert.equal(actual[key], expected[key], `${message}: ${key} changed after initialization.`);
  });
}

async function snapshotDailyPuzzle(browser, isoDate, triggerId = "", persistedGenericState = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await installOfflineSupabaseFixture(context);
  await installFixedDate(context, isoDate);
  await installHomeDefaults(context);
  if (persistedGenericState) {
    await context.addInitScript(() => {
      localStorage.setItem("checkmateQuest.realPuzzles.v1", JSON.stringify({ index: 0, mode: "Trainer", difficulty: "Expert" }));
    });
  }
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const cacheBefore = await captureBrowserCacheState(page);
    if (triggerId) {
      await page.locator(`#${triggerId}`).click();
      await page.waitForFunction(() => location.hash === "#puzzles?mode=daily", null, { timeout: 5000 });
    } else {
      await page.goto(`${baseUrl}/#puzzles?mode=daily`, { waitUntil: "domcontentloaded" });
    }
    await page.waitForFunction(() => {
      const board = document.getElementById("realPuzzleBoard");
      return board?.querySelectorAll("[data-square]").length === 64 && Boolean(board.dataset.puzzleId);
    }, null, { timeout: 15000 });
    const destination = await captureDestination(page);
    // The original defect appeared after the route was visible: a deferred
    // generic selector could replace Daily state. Check again after that work
    // and its queued renders have had time to settle.
    await page.waitForTimeout(1200);
    const destinationAfterAsyncInitialization = await captureDestination(page);
    assertSamePuzzle(destinationAfterAsyncInitialization, destination,
      "Daily destination must remain stable after asynchronous initialization");
    const cacheAfter = await captureBrowserCacheState(page);
    return { destination, destinationAfterAsyncInitialization, cacheBefore, cacheAfter };
  } finally {
    await context.close();
  }
}

function assertBoardContract(destination) {
  assert.equal(destination.squares.length, 64, "The actual Daily Puzzle board must contain exactly 64 squares.");
  const blackPerspective = destination.sideToMove === "b";
  destination.squares.forEach((entry, index) => {
    const row = Math.floor(index / 8);
    const column = index % 8;
    const expectedSquare = `${"abcdefgh"[blackPerspective ? 7 - column : column]}${blackPerspective ? row + 1 : 8 - row}`;
    assert.equal(entry.square, expectedSquare, `Puzzle square ${index} has the wrong chess coordinate.`);
    assert.equal(entry.parity, (row + column) % 2 === 0 ? "light" : "dark", `Puzzle square ${entry.square} has the wrong board parity.`);
  });
  const [placement, activeColor] = destination.fen.split(/\s+/);
  assert.equal(destination.sideToMove, activeColor, "Rendered side-to-move must match the active Daily Puzzle position.");
  const expectedPieces = [];
  placement.split("/").forEach((rank, row) => {
    let column = 0;
    [...rank].forEach((token) => {
      const empty = Number(token);
      if (Number.isInteger(empty) && empty > 0) column += empty;
      else {
        const code = { p: "p", n: "n", b: "b", r: "r", q: "q", k: "k" }[token.toLowerCase()];
        expectedPieces.push({ square: `${"abcdefgh"[column]}${8 - row}`, piece: `${token === token.toUpperCase() ? "w" : "b"}${code}` });
        column += 1;
      }
    });
    assert.equal(column, 8, `FEN rank ${8 - row} must expand to eight squares.`);
  });
  const bySquare = (left, right) => left.square.localeCompare(right.square);
  const actualPieces = destination.squares.filter((entry) => entry.piece).map(({ square, piece }) => ({ square, piece })).sort(bySquare);
  expectedPieces.sort(bySquare);
  assert.deepEqual(actualPieces, expectedPieces, "Rendered Daily Puzzle pieces must match the active puzzle FEN.");
  assert.equal(destination.mode, "Daily", "The real puzzle screen must remain in Daily mode.");
}

async function assertNoHorizontalOverflow(browser) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 624, height: 900 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await installOfflineSupabaseFixture(context);
    await installHomeDefaults(context);
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#homePlayAction");
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        actionRail: document.querySelectorAll(".home-next-move-strip-action").length
      }));
      assert.equal(layout.actionRail, 4, `Expected four action-rail entries at ${viewport.width}px.`);
      assert(layout.scrollWidth <= layout.clientWidth, `Homepage horizontally overflows at ${viewport.width}px.`);
    } finally {
      await context.close();
    }
  }
}

async function main() {
  staticContracts();
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer();
    const today = "2026-09-15T12:00:00";
    const tomorrow = "2026-09-16T12:00:00";
    const first = await snapshotDailyPuzzle(browser, today);
    const repeated = await snapshotDailyPuzzle(browser, today);
    const actionRail = await snapshotDailyPuzzle(browser, today, "newToChessButton", true);
    const nextDay = await snapshotDailyPuzzle(browser, tomorrow);
    assertSamePuzzle(repeated.destination, first.destination, "Repeated Daily Puzzle resolution must be stable for one calendar date");
    assertBoardContract(first.destination);
    assertBoardContract(actionRail.destination);
    assertSamePuzzle(actionRail.destination, first.destination,
      "The Daily Puzzle action rail must open the canonical Daily Puzzle");
    assert.equal(nextDay.destination.date, "2026-09-16", "Daily Puzzle date identity did not advance to the next date.");
    if (first.destination.catalogueSize > 1) {
      assert.notEqual(nextDay.destination.puzzleId, first.destination.puzzleId,
        "The next calendar day must resolve a different Daily Puzzle when the catalogue has multiple entries.");
    }
    assert.equal(first.cacheBefore.serviceWorkerRegistrations, 0, "A fresh blocked-worker origin must begin without a service worker.");
    assert.deepEqual(first.cacheBefore.cacheNames, [], "A fresh blocked-worker origin must begin without Cache Storage.");
    await assertNoHorizontalOverflow(browser);
    process.stdout.write(`PASS Daily Puzzle route and board regression (${first.destination.puzzleId} ${first.destination.sourceFen})\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
