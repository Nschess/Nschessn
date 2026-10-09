const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".wasm", "application/wasm"], [".webp", "image/webp"]
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

function objectiveMove(puzzle, move, Chess) {
  const game = new Chess(puzzle.fen);
  const mover = game.turn();
  const applied = game.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  if (!applied) return false;
  if (puzzle.objective === "mate-in-one") return game.isCheckmate();
  if (puzzle.objective !== "royal-fork" || applied.piece !== "n" || !game.isCheck()) return false;
  const enemy = game.turn();
  const queen = game.board().flat().find((piece) => piece && piece.type === "q" && piece.color === enemy);
  if (!queen || !game.attackers(queen.square, mover).includes(applied.to)) return false;
  return game.moves({ verbose: true }).every((reply) => {
    const continuation = new Chess(game.fen());
    continuation.move(reply.san);
    return continuation.get(queen.square)?.type === "q" && continuation.attackers(queen.square, mover).includes(applied.to);
  });
}

async function playMove(page, move) {
  await page.locator(`#dailyPuzzleBoard [data-square="${move.from}"]`).click();
  await page.locator(`#dailyPuzzleBoard [data-square="${move.to}"]`).click();
}

async function main() {
  const { chromium } = require("playwright");
  const { Chess } = await import(pathToFileURL(path.join(root, "assets/vendor/chess.js-1.0.0.mjs")));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/daily-puzzles-original.v1.json"), "utf8"));
  const core = await import(pathToFileURL(path.join(root, "assets/daily-puzzle-core.mjs")));
  const server = await startServer();
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  if (process.argv.includes("--serve")) {
    console.log(`Daily Puzzle local browser preview: ${origin}/#puzzles`);
    await new Promise((resolve) => process.once("SIGINT", resolve));
    await new Promise((resolve) => server.close(resolve));
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
    if (process.env.DAILY_BLOCK_EXTERNAL !== "0") await context.route("https://**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/#puzzles`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const button = document.querySelector("[data-daily-puzzle-launch]");
      return button && !button.disabled;
    }, null, { timeout: 10000 });
    const beforeOpenResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname));
    const initialShellBytes = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).origin === location.origin && /\/(?:index\.html|assets\/app\.(?:css|js)|assets\/daily-puzzle-launcher\.mjs)$/.test(new URL(entry.name).pathname))
      .reduce((total, entry) => total + entry.decodedBodySize, 0));
    assert.equal(beforeOpenResources.some((pathname) => pathname.endsWith("/assets/daily-puzzle.mjs")), false, "the full Daily interaction module is not downloaded before the player opens the mode");
    assert.equal(beforeOpenResources.some((pathname) => pathname.endsWith("/data/daily-puzzles-original.v1.json")), false, "the Daily puzzle pack is not downloaded before the player opens the mode");
    const dailyOpenStarted = await page.evaluate(() => {
      window.__dailyOpenStarted = performance.now();
      document.querySelector("[data-daily-puzzle-launch]").click();
      return window.__dailyOpenStarted;
    });
    await page.waitForFunction(() => document.querySelector("[data-daily-puzzle-launch]")?.disabled === true);
    await assert.doesNotReject(() => page.locator("#dailyPuzzlePanel").waitFor({ state: "visible" }));
    await page.waitForFunction(() => document.querySelector("[data-daily-puzzle-launch]")?.disabled === false);
    const dailyOpenMs = await page.evaluate((started) => Math.round(performance.now() - started), dailyOpenStarted);
    assert.ok(dailyOpenMs < 1800, `the selected puzzle opens within 1.8s in the local cold browser (${dailyOpenMs}ms)`);
    const afterOpenResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname));
    assert.ok(afterOpenResources.some((pathname) => pathname.endsWith("/assets/daily-puzzle.mjs")), "the Daily interaction module loads when requested");
    assert.ok(afterOpenResources.some((pathname) => pathname.endsWith("/data/daily-puzzles-original.v1.json")), "the original puzzle pack loads when requested");
    assert.equal(await page.locator("#realPuzzles .real-puzzle-shell").isVisible(), false, "Daily mode replaces rather than duplicates the practice board");

    const today = await page.evaluate(() => {
      const date = new Date();
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    });
    const puzzle = core.selectDailyPuzzle(today, catalog.puzzles);
    const legal = new Chess(puzzle.fen).moves({ verbose: true });
    const correct = legal.filter((move) => objectiveMove(puzzle, move, Chess));
    const wrong = legal.find((move) => !objectiveMove(puzzle, move, Chess));
    assert.ok(correct.length, `${puzzle.id} exposes at least one accepted move`);
    assert.ok(wrong, `${puzzle.id} has a legal alternative for wrong-move feedback`);

    assert.equal(await page.locator("#dailyPuzzleBoard button[data-square]").count(), 64);
    assert.equal(await page.locator("#dailyPuzzleSide").innerText(), new Chess(puzzle.fen).turn() === "w" ? "White to move" : "Black to move", "the displayed side to move matches the validated FEN");
    const boardIdentity = await page.evaluate((sourceSquare) => {
      const board = document.getElementById("dailyPuzzleBoard");
      const source = board.querySelector(`button[data-square="${sourceSquare}"]`);
      const selectSamples = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const started = performance.now();
        source.click();
        selectSamples.push(performance.now() - started);
        source.click();
      }
      const retained = source === board.querySelector(`button[data-square="${source.dataset.square}"]`);
      source.focus({ preventScroll: true });
      selectSamples.sort((a, b) => a - b);
      return { selectMs: Math.round(selectSamples[2] * 100) / 100, retained };
    }, legal[0].from);
    assert.equal(boardIdentity.retained, true, "selecting a square preserves the existing button node and keyboard focus");
    assert.ok(boardIdentity.selectMs < 35, `selecting a square completes within 35ms (${boardIdentity.selectMs}ms)`);
    await page.keyboard.press("ArrowRight");
    assert.ok(await page.locator("#dailyPuzzleBoard button:focus").count(), "the board supports keyboard focus movement");

    const illegalFrom = legal[0].from;
    const legalFrom = new Set(legal.filter((move) => move.from === illegalFrom).map((move) => move.to));
    const sourcePosition = new Chess(puzzle.fen);
    const movingColor = sourcePosition.get(illegalFrom).color;
    const illegalTo = [..."abcdefgh"].flatMap((file) => [..."12345678"].map((rank) => `${file}${rank}`))
      .find((square) => square !== illegalFrom && !legalFrom.has(square) && sourcePosition.get(square)?.color !== movingColor);
    assert.ok(illegalTo, "an empty or enemy square exists that is not a legal destination");
    await page.locator(`#dailyPuzzleBoard [data-square="${illegalFrom}"]`).click();
    await page.locator(`#dailyPuzzleBoard [data-square="${illegalTo}"]`).click();
    assert.match(await page.locator("#dailyPuzzleFeedback").innerText(), /not a legal destination/i);
    assert.equal(await page.evaluate(() => localStorage.getItem("nschess.dailyPuzzle.v1")), null, "an illegal move cannot count as an attempt");
    await page.locator(`#dailyPuzzleBoard [data-square="${illegalFrom}"]`).click();

    await playMove(page, wrong);
    await page.getByText(/Not quite/i).waitFor({ state: "visible" });
    let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nschess.dailyPuzzle.v1")));
    assert.equal(saved.days[today].attempts, 1);
    assert.equal(saved.days[today].wrong, 1);
    assert.equal(saved.days[today].completed, false);

    await page.locator("#dailyPuzzleHintButton").click();
    assert.equal(await page.locator("#dailyPuzzleHint").isVisible(), true);
    assert.equal(await page.locator("#dailyPuzzleRevealButton").isHidden(), true, "solution stays out of the live solve flow");
    assert.equal(await page.locator("#dailyPuzzleRestartButton").isHidden(), true, "no redundant restart/replay control appears before completion");
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nschess.dailyPuzzle.v1")));
    assert.equal(saved.days[today].completed, false, "a hint alone does not complete the local puzzle");
    await playMove(page, correct[0]);
    await page.getByText(/Solved:/).waitFor({ state: "visible" });
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nschess.dailyPuzzle.v1")));
    assert.equal(saved.days[today].attempts, 2);
    assert.equal(saved.days[today].wrong, 1);
    assert.equal(saved.days[today].completed, true);
    assert.equal(await page.locator("#dailyPuzzleStreak").innerText(), "1 day");
    assert.match(await page.locator("#dailyPuzzleFeedback").innerText(), /no XP, rating, coins, or account reward/i);
    assert.equal(await page.locator("#dailyPuzzleHintButton").isHidden(), true, "the hint action is replaced by post-solve options");
    assert.equal(await page.locator("#dailyPuzzleRevealButton").isVisible(), true);
    assert.equal(await page.locator("#dailyPuzzleRestartButton").innerText(), "Practice again");
    await page.locator("#dailyPuzzleRevealButton").click();
    assert.match(await page.locator("#dailyPuzzleHint").innerText(), /Solution:/);

    const layouts = [];
    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const measure = await page.evaluate(() => {
        const panel = document.querySelector("#dailyPuzzlePanel");
        const board = document.querySelector("#dailyPuzzleBoard");
        const rect = board.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const focus = getComputedStyle(document.activeElement).outlineStyle;
        return {
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          panelWidth: panel.clientWidth,
          panelRight: panelRect.right,
          boardWidth: rect.width,
          boardHeight: rect.height,
          focusVisible: document.activeElement.matches(":focus-visible") || focus !== "none"
        };
      });
      assert.ok(measure.documentWidth <= width + 1, `no page overflow at ${width}px: ${JSON.stringify(measure)}`);
      assert.ok(measure.panelRight <= width + 1, `Daily panel fits ${width}px`);
      assert.ok(measure.boardWidth > 0 && Math.abs(measure.boardWidth - measure.boardHeight) < 1, `square board at ${width}px`);
      layouts.push(measure);
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("[data-daily-puzzle-launch]") && !document.querySelector("[data-daily-puzzle-launch]").disabled, null, { timeout: 10000 });
    await page.locator("[data-daily-puzzle-launch]").click();
    await page.locator("#dailyPuzzlePanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#dailyPuzzleAttempts").innerText(), "2", "attempts persist on reload");
    assert.match(await page.locator("#dailyPuzzleFeedback").innerText(), /Solved today/);
    assert.equal(await page.locator("#dailyPuzzleBoard button[data-square]:disabled").count(), 64, "a saved completion reopens in a clear read-only success state");
    assert.equal(await page.locator("#dailyPuzzleRestartButton").isVisible(), true);
    await page.locator("#dailyPuzzleRestartButton").click();
    const beforeReplay = await page.evaluate(() => localStorage.getItem("nschess.dailyPuzzle.v1"));
    const replayWrong = new Chess(puzzle.fen).moves({ verbose: true }).find((move) => !objectiveMove(puzzle, move, Chess));
    await playMove(page, replayWrong);
    const afterReplay = await page.evaluate(() => localStorage.getItem("nschess.dailyPuzzle.v1"));
    assert.equal(afterReplay, beforeReplay, "completed replay cannot rewrite the saved record");

    await page.locator('.real-puzzle-modes [data-real-mode="Trainer"]').click();
    assert.equal(await page.locator("#dailyPuzzlePanel").isHidden(), true, "Trainer remains a distinct existing mode");
    assert.equal(await page.locator("#realPuzzles .real-puzzle-shell").isVisible(), true);
    for (const mode of ["Rush", "Streak", "Battle"]) assert.equal(await page.locator(`.real-puzzle-modes [data-real-mode="${mode}"]`).count(), 1);

    await page.waitForTimeout(1200);
    const workerReady = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      try { return Boolean(await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 8000))])); }
      catch { return false; }
    });
    if (!workerReady) throw new Error("service worker did not register; offline cache verification is incomplete");
    await context.setOffline(true);
    await page.goto(`${origin}/#puzzles`, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("[data-daily-puzzle-launch]") && !document.querySelector("[data-daily-puzzle-launch]").disabled, null, { timeout: 10000 });
    assert.match(await page.locator("[data-daily-puzzle-launch]").innerText(), /Daily/);
    await page.locator("[data-daily-puzzle-launch]").click();
    await page.locator("#dailyPuzzlePanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#dailyPuzzlePanel").isVisible(), true, "cached puzzle module and catalog reopen offline");
    assert.equal(await page.locator("#dailyPuzzleBoard button[data-square]").count(), 64, "the cached chess rules and pieces render offline");
    const beforeOfflineReplay = await page.evaluate(() => localStorage.getItem("nschess.dailyPuzzle.v1"));
    await playMove(page, correct[0]);
    assert.match(await page.locator("#dailyPuzzleFeedback").innerText(), /Practice only|record is unchanged/i, "an offline legal move is processed by cached chess rules without changing the saved completion");
    assert.equal(await page.evaluate(() => localStorage.getItem("nschess.dailyPuzzle.v1")), beforeOfflineReplay, "offline replay does not mint another completion");
    await context.setOffline(false);

    const dailyResourceMetrics = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => /daily-puzzle|daily-puzzles-original|chess\.js-1\.0\.0|pieces\/merida/.test(entry.name))
      .map((entry) => ({ path: new URL(entry.name).pathname, durationMs: Math.round(entry.duration), transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize })));
    console.log(JSON.stringify({ result: "PASS", puzzle: puzzle.id, initialShellBytes, dailyOpenMs, boardSelectionMs: boardIdentity.selectMs, boardSelectionRetainsSquareNode: boardIdentity.retained, dailyResourceMetrics, legalAlternatives: correct.length, wrongMove: wrong.san, completionPersisted: true, replayNoMutation: true, offlineReopen: true, layouts }, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
