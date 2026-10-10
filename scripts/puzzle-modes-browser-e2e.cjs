const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".webp", "image/webp"], [".wasm", "application/wasm"]
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
      fs.readFile(target, (error, body) => {
        if (error) { response.writeHead(404).end("Not found"); return; }
        response.writeHead(200, {
          "Content-Type": contentTypes.get(path.extname(target)) || "application/octet-stream",
          "Cache-Control": "no-cache"
        });
        response.end(body);
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function moveFromUci(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) };
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`.toLowerCase();
}

function puzzleStart(record, Chess) {
  const game = new Chess(record.fen || record.FEN);
  const line = [...(record.moves || record.Moves.split(/\s+/))].map((move) => String(move).toLowerCase());
  if (record.primer) {
    const primerUci = line.shift();
    const primer = game.moves({ verbose: true }).find((move) => moveToUci(move) === primerUci);
    assert.ok(primer, `${record.id}: primer is legal`);
    game.move({ from: primer.from, to: primer.to, ...(primer.promotion ? { promotion: primer.promotion } : {}) });
  }
  return { game, line, playerSide: game.turn() };
}

function preparePuzzle(record, Chess) {
  const { game, line, playerSide } = puzzleStart(record, Chess);
  const playerMoves = [];
  for (const uci of line) {
    const move = game.moves({ verbose: true }).find((candidate) => moveToUci(candidate) === uci);
    assert.ok(move, `${record.id}: ${uci} is legal in its line position`);
    if (game.turn() === playerSide) playerMoves.push(uci);
    game.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  }
  return {
    playerMoves,
    firstMove: line[0] || "",
    wrongMove: (() => {
      const { game: current, line: remaining } = puzzleStart(record, Chess);
      return current.moves({ verbose: true }).map(moveToUci).find((uci) => uci !== remaining[0]) || "";
    })()
  };
}

function validateCatalog(catalog, Chess) {
  let legalPlies = 0;
  const positions = new Set();
  for (const record of catalog) {
    const { game, line } = puzzleStart(record, Chess);
    assert.ok(line.length, `${record.id}: puzzle has a solution line`);
    positions.add((record.fen || record.FEN).trim().split(/\s+/).slice(0, 4).join(" "));
    for (const uci of line) {
      const move = game.moves({ verbose: true }).find((candidate) => moveToUci(candidate) === uci);
      assert.ok(move, `${record.id}: ${uci} is legal at the position where it is prescribed`);
      game.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
      legalPlies += 1;
    }
  }
  return { puzzles: catalog.length, uniquePositions: positions.size, legalPlies };
}

async function getCurrentPuzzle(page, catalog, Chess) {
  await page.waitForFunction(() => window.checkmatePuzzleRuntime?.event === "puzzle-loaded", null, { timeout: 20000 });
  const runtime = await page.evaluate(() => window.checkmatePuzzleRuntime);
  const record = catalog.find((item) => item.id === runtime.puzzleId || item.PuzzleId === runtime.puzzleId);
  assert.ok(record, `loaded runtime puzzle ${runtime.puzzleId} belongs to the bundled Lichess CC0 collection`);
  const prepared = preparePuzzle(record, Chess);
  assert.ok(prepared.playerMoves.length, `${runtime.puzzleId} has a player solution move`);
  return { runtime, record, ...prepared };
}

async function playUci(page, uci) {
  const move = moveFromUci(uci);
  await page.locator(`#realPuzzleBoard [data-square="${move.from}"]`).click();
  await page.locator(`#realPuzzleBoard [data-square="${move.to}"]`).click();
  if (move.promotion) await page.locator(`#realPuzzleBoard + .promotion-picker [data-promotion="${move.promotion}"]`).click().catch(async () => {
    await page.locator(`.promotion-picker [data-promotion="${move.promotion}"]`).click();
  });
  await page.waitForFunction(() => ["PlayerTurn", "Completed"].includes(document.querySelector("#realPuzzles")?.dataset.puzzlePhase), null, { timeout: 7000 });
}

async function solveCurrent(page, catalog, Chess) {
  const puzzle = await getCurrentPuzzle(page, catalog, Chess);
  for (const move of puzzle.playerMoves) await playUci(page, move);
  await page.waitForFunction(() => document.querySelector("#realPuzzles")?.dataset.puzzlePhase === "Completed", null, { timeout: 7000 });
  return puzzle;
}

async function playLegalWrongMove(page, puzzle) {
  assert.ok(puzzle.wrongMove, `${puzzle.runtime.puzzleId} offers a legal alternative to test wrong-answer feedback`);
  await playUci(page, puzzle.wrongMove);
}

async function waitForPuzzleChange(page, previousId) {
  await page.waitForFunction((id) => window.checkmatePuzzleRuntime?.event === "puzzle-loaded"
    && window.checkmatePuzzleRuntime.puzzleId !== id, previousId, { timeout: 10000 });
}

async function main() {
  const { chromium } = require("playwright");
  const { Chess } = await import(pathToFileURL(path.join(root, "assets/vendor/chess.js-1.0.0.mjs")));
  const catalogPayload = JSON.parse(fs.readFileSync(path.join(root, "data/puzzles.json"), "utf8"));
  const catalog = Array.isArray(catalogPayload) ? catalogPayload : catalogPayload.puzzles;
  const catalogCheck = validateCatalog(catalog, Chess);
  const appSource = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let context;
  let page;
  const pageErrors = [];
  const externalRequests = [];
  try {
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        externalRequests.push(new URL(route.request().url()).origin);
        await route.abort();
        return;
      }
      await route.continue();
    });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const nativeNow = Date.now.bind(Date);
      let offset = 0;
      Date.now = () => nativeNow() + offset;
      Object.defineProperty(window, "__advancePuzzleClock", { value: (milliseconds) => { offset += milliseconds; } });
    });
    await page.goto(`${origin}/#puzzles`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(() => window.checkmatePuzzleRuntime?.event === "puzzle-loaded"
      && document.querySelectorAll("#realPuzzleBoard [data-square]").length === 64, null, { timeout: 20000 });

    assert.match(await page.locator("#realPuzzleAccuracy").innerText(), /^—$/, "accuracy does not fabricate 100% before attempts");
    assert.match(await page.locator("#real-puzzle-local-note, .real-puzzle-local-note").last().innerText(), /does not award account XP, coins, or Elo/i,
      "the supported puzzle modes clearly disclose that progress and rating are local, not account rewards");
    assert.equal(await page.locator("#realPuzzleHintButton").count(), 1, "there is one Hint action");
    assert.equal(await page.locator("#realPuzzleReplay").count(), 1, "there is one Replay line action");
    assert.equal(await page.locator("#realPuzzleBoardRestart").count(), 1, "there is one restart action");
    assert.equal(await page.locator("#realPuzzleBoardNext").count(), 1, "there is one next-position action");
    assert.equal(await page.locator("#realPuzzleNameList").count(), 0, "the hidden, repeatedly regenerated puzzle-name list is gone");
    for (const mode of ["Trainer", "Rush", "Streak", "Battle"]) {
      assert.equal(await page.locator(`.real-puzzle-modes [data-real-mode="${mode}"]`).count(), 1, `${mode} is a single supported mode control`);
    }
    assert.match(appSource, /const rewardMessage = isApplicationAuthenticated\(\)[\s\S]{0,180}\? "Practice saved on this device\. No account XP, coins, or rating were awarded\."/,
      "authenticated puzzle completion presentation explicitly denies account reward without changing server settlement");
    assert.doesNotMatch(appSource, /settle_player_progression\([^)]*puzzle_solved/s, "puzzle practice does not gain a generic settlement path");

    const trainerPuzzle = await getCurrentPuzzle(page, catalog, Chess);
    const selection = await page.evaluate((from) => {
      const board = document.getElementById("realPuzzleBoard");
      const square = board.querySelector(`[data-square="${from}"]`);
      const samples = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        square.click();
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return {
        medianMs: Math.round(samples[2] * 100) / 100,
        selected: square.classList.contains("selected"),
        retainedNode: square === board.querySelector(`[data-square="${from}"]`)
      };
    }, moveFromUci(trainerPuzzle.firstMove).from);
    assert.ok(selection.medianMs < 35, `piece selection responds within 35ms (${selection.medianMs}ms)`);
    assert.equal(selection.selected, true, "the selected piece receives immediate visual state");
    assert.equal(selection.retainedNode, true, "piece selection retains the existing square node");
    await playLegalWrongMove(page, trainerPuzzle);
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /full line stays here when you solve it/i,
      "Trainer gives non-pressured, explanatory wrong-answer feedback");
    assert.equal(await page.locator("#realPuzzleAccuracy").innerText(), "0%", "one wrong attempt is reported as zero accuracy");
    await page.locator("#realPuzzleHintButton").click();
    assert.ok((await page.locator("#realPuzzleHint").innerText()).trim().length > 0, "Trainer provides a visible hint");
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /device-local practice bonus; account rewards are never affected/i,
      "hint feedback distinguishes a local practice bonus from account rewards");
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1")))).attempts, 1,
      "opening a hint does not record a move attempt");
    await page.locator("#realPuzzleBoardRestart").click();
    for (const move of trainerPuzzle.playerMoves) await playUci(page, move);
    await page.waitForFunction(() => document.querySelector("#realPuzzles")?.dataset.puzzlePhase === "Completed", null, { timeout: 7000 });
    const trainerSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1")));
    assert.equal(trainerSaved.attempts, 2, "Trainer records wrong and correct solve attempts");
    assert.equal(trainerSaved.failed, 1);
    assert.equal(trainerSaved.correct, 1);
    assert.equal(await page.locator("#realPuzzleAccuracy").innerText(), "50%");
    await page.waitForTimeout(1400);
    assert.equal((await page.evaluate(() => window.checkmatePuzzleRuntime.puzzleId)), trainerPuzzle.runtime.puzzleId,
      "Trainer keeps the solved position and full explanation available for study");
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /^Solved in /);
    const beforeReplay = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1"));
      return { attempts: state.attempts, solved: state.solved, rating: state.rating, streak: state.streak };
    });
    await page.locator("#realPuzzleReplay").click();
    await page.getByText(/^Replay done\./).waitFor({ timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1"));
      return { attempts: state.attempts, solved: state.solved, rating: state.rating, streak: state.streak };
    }), beforeReplay, "replaying a completed line does not rewrite score or completion");
    const reloadAuditBefore = await page.evaluate(() => {
      const workspaces = JSON.parse(localStorage.getItem("checkmateQuest.accountWorkspaces.v1") || "{}");
      const local = JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1") || "null");
      const guest = JSON.parse(workspaces.accounts?.guest?.values?.["checkmateQuest.realPuzzles.v1"] || "null");
      return {
        owner: localStorage.getItem("checkmateQuest.accountWorkspaceOwner.v1"),
        localAttempts: local?.attempts ?? null,
        guestAttempts: guest?.attempts ?? null,
        guestSolved: guest?.solved?.length ?? null
      };
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.checkmatePuzzleRuntime?.event === "puzzle-loaded", null, { timeout: 20000 });
    const trainerAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.realPuzzles.v1")));
    assert.equal(trainerAfterReload.attempts, 2, `attempt count survives a reload (before ${JSON.stringify(reloadAuditBefore)}, after ${JSON.stringify(trainerAfterReload)})`);
    assert.equal(trainerAfterReload.correct, 1, "correct-solve count survives a reload");
    assert.ok(trainerAfterReload.solved.includes(trainerPuzzle.runtime.puzzleId), "completed puzzle identity survives a reload");
    assert.equal(await page.locator("#realPuzzleAccuracy").innerText(), "50%", "accuracy rehydrates from saved local practice data");

    await page.locator('.real-puzzle-modes [data-real-mode="Rush"]').click();
    assert.equal(await page.locator("#realPuzzleTimer").innerText(), "03:00", "Rush starts with a three-minute countdown, not an elapsed count-up");
    const rushPuzzle = await getCurrentPuzzle(page, catalog, Chess);
    const emptySquare = await page.locator("#realPuzzleBoard .puzzle-square").evaluateAll((squares) => squares.find((square) => !square.querySelector("[data-piece]"))?.dataset.square);
    assert.ok(emptySquare, "Rush board has an empty square for inert input");
    await page.locator(`#realPuzzleBoard [data-square="${emptySquare}"]`).click();
    assert.equal(await page.locator("#realPuzzleTimer").innerText(), "03:00", "an empty-square tap does not start the Rush clock");
    await page.locator(`#realPuzzleBoard [data-square="${moveFromUci(rushPuzzle.firstMove).from}"]`).click();
    await page.waitForTimeout(1200);
    assert.notEqual(await page.locator("#realPuzzleTimer").innerText(), "03:00", "the Rush clock starts on the first selected piece");
    await page.locator(`#realPuzzleBoard [data-square="${moveFromUci(rushPuzzle.firstMove).from}"]`).click();
    await playLegalWrongMove(page, rushPuzzle);
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /Rush is still live/i);
    for (const move of rushPuzzle.playerMoves) await playUci(page, move);
    await page.waitForFunction(() => document.querySelector("#realPuzzleRushScore")?.textContent === "1", null, { timeout: 7000 });
    await waitForPuzzleChange(page, rushPuzzle.runtime.puzzleId);
    const rushAfterSolve = await page.evaluate(() => ({
      puzzleId: window.checkmatePuzzleRuntime?.puzzleId,
      event: window.checkmatePuzzleRuntime?.event,
      phase: document.querySelector("#realPuzzles")?.dataset.puzzlePhase,
      mode: document.querySelector("#realPuzzleModeDescription")?.textContent,
      score: document.querySelector("#realPuzzleRushScore")?.textContent,
      feedback: document.querySelector("#realPuzzleFeedback")?.textContent
    }));
    const rushNextId = rushAfterSolve.puzzleId;
    assert.notEqual(rushNextId, rushPuzzle.runtime.puzzleId, `Rush advances after a correct solve: ${JSON.stringify(rushAfterSolve)}`);
    assert.equal(await page.locator("#realPuzzleRushScore").innerText(), "1", "Rush increments its solve score exactly once");
    assert.notEqual(await page.locator("#realPuzzleTimer").innerText(), "03:00", "auto-advance does not reset the Rush clock");

    await page.evaluate(() => { location.hash = "#top"; });
    await page.waitForFunction(() => document.querySelector("#puzzles")?.hidden === true, null, { timeout: 5000 });
    const pausedTime = await page.locator("#realPuzzleTimer").innerText();
    await page.evaluate(() => window.__advancePuzzleClock(60000));
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#realPuzzleTimer").innerText(), pausedTime, "leaving Puzzles pauses Rush instead of consuming hidden time");
    await page.evaluate(() => { location.hash = "#puzzles"; });
    await page.waitForFunction(() => document.querySelector("#puzzles")?.classList.contains("is-active-panel"), null, { timeout: 5000 });
    await page.waitForTimeout(350);
    const resumedTime = await page.locator("#realPuzzleTimer").innerText();
    const parseClock = (clock) => clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    assert.ok(parseClock(resumedTime) <= parseClock(pausedTime)
      && parseClock(resumedTime) >= parseClock(pausedTime) - 8,
    `returning to Puzzles resumes near the saved remaining time without consuming the minute spent away (${pausedTime} → ${resumedTime})`);
    await page.evaluate(() => window.__advancePuzzleClock(180000));
    await page.getByText(/Rush complete · \d+ solved in three minutes/i).waitFor({ timeout: 5000 });
    assert.equal(await page.locator("#realPuzzleBoard [data-square]:disabled").count(), 64, "timed-out Rush blocks every board square");
    assert.equal(await page.locator("#realPuzzleBoardRestart").innerText(), "New Rush", "timeout presents a clear new-run action");
    await page.locator("#realPuzzleBoardRestart").click();
    assert.equal(await page.locator("#realPuzzleTimer").innerText(), "03:00", "starting a new Rush resets the clock");
    assert.equal(await page.locator("#realPuzzleRushScore").innerText(), "0", "starting a new Rush resets only its session score");

    await page.locator('.real-puzzle-modes [data-real-mode="Streak"]').click();
    const firstStreakPuzzle = await getCurrentPuzzle(page, catalog, Chess);
    await solveCurrent(page, catalog, Chess);
    assert.match(await page.locator("#realPuzzleStreak").innerText(), /^1\//, "Streak increments on a verified complete solution");
    await page.locator('.real-puzzle-modes [data-real-mode="Streak"]').click();
    assert.match(await page.locator("#realPuzzleStreak").innerText(), /^1\//, "clicking the active mode does not erase a live Streak");
    await page.locator("#realPuzzleBoardRestart").click();
    const replayedStreakPuzzle = await solveCurrent(page, catalog, Chess);
    assert.equal(replayedStreakPuzzle.runtime.puzzleId, firstStreakPuzzle.runtime.puzzleId);
    assert.match(await page.locator("#realPuzzleStreak").innerText(), /^1\//, "re-solving the same completed position cannot farm Streak progress");
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /already solved, so it did not extend your Streak/i);
    await waitForPuzzleChange(page, firstStreakPuzzle.runtime.puzzleId);
    const nextStreakPuzzle = await getCurrentPuzzle(page, catalog, Chess);
    await playLegalWrongMove(page, nextStreakPuzzle);
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /^Streak broken/);
    assert.match(await page.locator("#realPuzzleStreak").innerText(), /^0\//, "a wrong move immediately resets the visible streak");

    await page.locator('.real-puzzle-modes [data-real-mode="Battle"]').click();
    assert.match(await page.locator("#realPuzzleModeDescription").innerText(), /Solo Battle.*No online opponent or bonus reward/i,
      "Battle is accurately described as supported solo practice rather than online matchmaking");
    const battlePuzzle = await getCurrentPuzzle(page, catalog, Chess);
    const ratingBeforeBattle = Number(await page.locator("#realPuzzleRating").innerText());
    await playLegalWrongMove(page, battlePuzzle);
    assert.equal(Number(await page.locator("#realPuzzleRating").innerText()), Math.max(600, ratingBeforeBattle - 10),
      "Battle's only distinct penalty is the documented device-local practice rating change");
    assert.match(await page.locator("#realPuzzleFeedback").innerText(), /local practice rating lost 10 points/i);
    assert.equal(await page.locator("#puzzles .real-puzzle-modes [data-daily-puzzle-launch]").isVisible(), true,
      "the independent Daily launch remains available beside the four distinct practice modes");

    const layouts = [];
    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const board = document.querySelector("#realPuzzleBoard").getBoundingClientRect();
        const panel = document.querySelector("#puzzles");
        const targets = [...document.querySelectorAll("#puzzles .real-puzzle-modes button, #puzzles .real-puzzle-difficulties button, #puzzles .real-board-quick-actions button, #puzzles .real-puzzle-actions button")]
          .filter((button) => !button.hidden);
        return {
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          puzzlePanelWidth: panel.clientWidth,
          boardWidth: Math.round(board.width),
          boardHeight: Math.round(board.height),
          smallestTouchTarget: Math.min(...targets.map((button) => button.getBoundingClientRect().height)),
          statusRole: document.querySelector("#realPuzzleFeedback")?.getAttribute("role"),
          accuracyLabel: document.querySelector("#realPuzzleAccuracy")?.getAttribute("aria-label")
        };
      });
      assert.ok(layout.documentWidth <= width + 1, `puzzle view has no horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.boardWidth > 0 && Math.abs(layout.boardWidth - layout.boardHeight) <= 1, `board remains square at ${width}px`);
      assert.equal(layout.statusRole, "status", "move feedback remains a polite accessible status region");
      assert.ok(layout.smallestTouchTarget >= (width <= 580 ? 44 : 40), `puzzle controls are comfortably tappable without inflating desktop controls at ${width}px: ${JSON.stringify(layout)}`);
      layouts.push(layout);
    }

    assert.deepEqual(pageErrors, [], `browser reports no uncaught application errors: ${pageErrors.join("; ")}`);
    console.log(JSON.stringify({
      result: "PASS",
      browser: "local Playwright Chromium; external network blocked",
      catalog: catalogCheck,
      moveSelection: selection,
      modes: {
        trainer: "wrong/correct attempt, accuracy, solved line retained, replay leaves progress unchanged",
        rush: "three-minute countdown, no empty-tap start, score/auto-advance, route pause/resume, timeout lock/new run",
        streak: "correct solution advances and increments; wrong answer resets immediately",
        battle: "honest solo-mode copy and exact local wrong-move penalty"
      },
      accuracyBeforeAttempts: "—",
      layouts,
      externalRequestsBlocked: externalRequests.length,
      browserErrors: pageErrors.length
    }, null, 2));
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
