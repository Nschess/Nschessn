const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/daily-puzzles-original.v1.json"), "utf8"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

async function main() {
  const core = await import(pathToFileURL(path.join(root, "assets/daily-puzzle-core.mjs")));
  const { Chess, validateFen } = await import(pathToFileURL(path.join(root, "assets/vendor/chess.js-1.0.0.mjs")));

  assert.equal(catalog.version, 1);
  assert.match(catalog.dateConvention, /UTC/);
  assert.match(catalog.provenance.authorship, /no game, book, puzzle collection, or third-party puzzle database/i);
  assert.match(catalog.provenance.rightsNote, /ownership should be confirmed/i);
  assert.ok(catalog.puzzles.length >= 30, "the curated original pack should cover at least a month of daily play");
  assert.equal(new Set(catalog.puzzles.map((puzzle) => puzzle.id)).size, catalog.puzzles.length);
  assert.equal(new Set(catalog.puzzles.map((puzzle) => puzzle.fen)).size, catalog.puzzles.length, "each authored position is distinct");

  for (const puzzle of catalog.puzzles) {
    const valid = validateFen(puzzle.fen);
    assert.equal(valid.ok, true, `${puzzle.id} FEN: ${valid.error || "valid"}`);
    const position = new Chess(puzzle.fen);
    assert.equal(position.isCheckmate() || position.isStalemate(), false, `${puzzle.id} must be playable at start`);
    const nonMovingKing = position.board().flatMap((row, rankIndex) => row.map((piece, fileIndex) => piece?.type === "k" && piece.color !== position.turn()
      ? `${"abcdefgh"[fileIndex]}${8 - rankIndex}` : null)).find(Boolean);
    assert.ok(nonMovingKing, `${puzzle.id} has the opposing king`);
    assert.equal(position.attackers(nonMovingKing, position.turn()).length, 0, `${puzzle.id} must not begin with the previous mover's king illegally in check`);
    const [from, to, promotion] = [puzzle.solutionUci.slice(0, 2), puzzle.solutionUci.slice(2, 4), puzzle.solutionUci[4]];
    const candidate = position.moves({ verbose: true }).find((move) => move.from === from && move.to === to && (!move.promotion || move.promotion === promotion));
    assert.ok(candidate, `${puzzle.id} authored line must be a legal move`);
    const after = new Chess(puzzle.fen);
    const move = after.move({ from, to, ...(promotion ? { promotion } : {}) });
    assert.ok(move);

    let acceptedMoves;
    if (puzzle.objective === "mate-in-one") {
      assert.equal(after.isCheckmate(), true, `${puzzle.id} must actually checkmate`);
      acceptedMoves = position.moves({ verbose: true }).filter((legalMove) => {
        const trial = new Chess(puzzle.fen);
        trial.move({ from: legalMove.from, to: legalMove.to, ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}) });
        return trial.isCheckmate();
      });
      assert.ok(acceptedMoves.length > 0);
      assert.ok(acceptedMoves.some((legalMove) => legalMove.from === from && legalMove.to === to), "declared illustrative mate belongs to the accepted objective set");
      if (acceptedMoves.length > 1) assert.match(puzzle.prompt, /any/i, `${puzzle.id} explicitly accepts equivalent mating alternatives`);
      // All equivalent mating alternatives are intentionally valid: the UI asks for any mate in one.
      assert.ok(acceptedMoves.every((legalMove) => {
        const trial = new Chess(puzzle.fen);
        trial.move({ from: legalMove.from, to: legalMove.to, ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}) });
        return trial.isCheckmate();
      }));
    } else {
      assert.equal(move.piece, "n", `${puzzle.id} is a knight tactic`);
      assert.equal(after.isCheck(), true, `${puzzle.id} must check the king`);
      const enemy = after.turn();
      const queen = after.board().flat().find((piece) => piece && piece.type === "q" && piece.color === enemy);
      assert.ok(queen, `${puzzle.id} must retain the enemy queen`);
      assert.ok(after.attackers(queen.square, position.turn()).includes(move.to), `${puzzle.id} knight must attack the queen`);
      const replies = after.moves({ verbose: true });
      assert.ok(replies.length > 0, `${puzzle.id} checking fork should leave legal king responses`);
      for (const reply of replies) {
        const response = new Chess(after.fen());
        response.move(reply.san);
        const remainingQueen = response.get(queen.square);
        assert.equal(remainingQueen?.type, "q", `${puzzle.id} queen remains after a legal check response`);
        assert.ok(response.attackers(queen.square, position.turn()).includes(move.to), `${puzzle.id} queen remains attacked after ${reply.san}`);
      }
      acceptedMoves = position.moves({ verbose: true }).filter((legalMove) => {
        const trial = new Chess(puzzle.fen);
        const applied = trial.move({ from: legalMove.from, to: legalMove.to, ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}) });
        if (!applied || applied.piece !== "n" || !trial.isCheck()) return false;
        const targetQueen = trial.board().flatMap((row, rankIndex) => row.map((piece, fileIndex) => piece?.type === "q" && piece.color === trial.turn()
          ? { square: `${"abcdefgh"[fileIndex]}${8 - rankIndex}`, piece } : null)).find(Boolean);
        if (!targetQueen || !trial.attackers(targetQueen.square, position.turn()).includes(applied.to)) return false;
        const responses = trial.moves({ verbose: true });
        return responses.length > 0 && responses.every((reply) => {
          const response = new Chess(trial.fen());
          response.move(reply.san);
          return response.get(targetQueen.square)?.type === "q" && response.attackers(targetQueen.square, position.turn()).includes(applied.to);
        });
      });
      assert.equal(acceptedMoves.length, 1, `${puzzle.id} must have one unambiguous checking-fork solution`);
      assert.equal(acceptedMoves[0].from, from);
      assert.equal(acceptedMoves[0].to, to);
    }
    assert.ok(position.moves({ verbose: true }).length > acceptedMoves.length, `${puzzle.id} includes a legal non-solution for truthful wrong-move feedback`);
  }

  const utcOne = "2026-10-09";
  const utcTwo = "2026-10-10";
  const utcThree = "2026-10-11";
  assert.equal(core.utcDayKey(new Date("2026-10-09T23:30:00-07:00")), "2026-10-10");
  assert.equal(core.selectDailyPuzzle(utcOne, catalog.puzzles).id, core.selectDailyPuzzle(utcOne, catalog.puzzles).id, "same UTC date selects one shared puzzle deterministically");
  assert.notEqual(core.selectDailyPuzzle(utcOne, catalog.puzzles).id, core.selectDailyPuzzle(utcTwo, catalog.puzzles).id);
  assert.notEqual(core.selectDailyPuzzle(utcTwo, catalog.puzzles).id, core.selectDailyPuzzle(utcThree, catalog.puzzles).id);
  assert.equal(core.selectDailyPuzzle("2026-02-30", catalog.puzzles), null);
  assert.equal(core.selectDailyPuzzle(utcOne, []), null);

  let state = core.parseDailyState(null).state;
  state = core.recordDailyAttempt(state, utcOne, false);
  assert.deepEqual(state.days[utcOne], { attempts: 1, wrong: 1, completed: false, assisted: false });
  state = core.recordDailyAttempt(state, utcOne, true, true);
  assert.deepEqual(state.days[utcOne], { attempts: 2, wrong: 1, completed: true, assisted: true });
  assert.equal(core.dailyStreak(state, utcOne), 1);
  const replayState = core.recordDailyAttempt(state, utcOne, false);
  assert.deepEqual(replayState, state, "replay cannot alter a completed daily record");
  assert.equal(replayState.days[utcTwo], undefined, "date change begins a separate local record");
  state = core.recordDailyAttempt(state, utcTwo, true);
  assert.equal(core.dailyStreak(state, utcTwo), 2);
  assert.equal(core.dailyStreak(state, "2026-10-13"), 0, "a missed UTC day resets the current streak");
  assert.equal(core.parseDailyState("not-json").recovered, true);
  assert.deepEqual(core.parseDailyState("not-json").state, { version: 1, days: {} });
  assert.equal(core.parseDailyState(JSON.stringify({ version: 99, days: {} })).recovered, true);
  const corrupt = core.parseDailyState({ version: 1, days: { "2026-10-09": { attempts: 1, wrong: 9, completed: true } } }).state;
  assert.deepEqual(corrupt.days[utcOne], { attempts: 1, wrong: 1, completed: true, assisted: false }, "corrupt counters are clamped and completion remains internally consistent");
  for (let offset = 0; offset < 450; offset += 1) {
    const date = new Date(Date.UTC(2025, 0, 1 + offset));
    state = core.recordDailyAttempt(state, core.utcDayKey(date), false);
  }
  assert.ok(Object.keys(state.days).length <= 400, "device-local history stays bounded");

  const html = read("index.html");
  const launcher = read("assets/daily-puzzle-launcher.mjs");
  const app = read("assets/daily-puzzle.mjs");
  const coreSource = read("assets/daily-puzzle-core.mjs");
  const worker = read("service-worker.js");
  assert.match(html, /data-daily-puzzle-launch/);
  assert.match(html, /dailyPuzzlePanel[\s\S]*?role="status"/);
  assert.match(html, /assets\/daily-puzzle-launcher\.mjs\?v=daily-compact-v1/);
  assert.doesNotMatch(html, /dailyPuzzleStartButton|dailyPuzzleLocalNote/, "Daily opens straight into the puzzle without a redundant start action or oversized explanatory card");
  assert.match(html, /daily-puzzle-actions[\s\S]*id="dailyPuzzleHintButton"[\s\S]*id="dailyPuzzleRevealButton" hidden[\s\S]*id="dailyPuzzleRestartButton" hidden/, "Only the contextual hint is visible during play; solution and replay are completion actions");
  assert.doesNotMatch(html, /src="assets\/daily-puzzle\.mjs|src="assets\/vendor\/chess\.js/);
  assert.match(launcher, /addEventListener\("click", async \(\) => \{[\s\S]*?loadPromise \|\|= import\("\.\/daily-puzzle\.mjs\?v=daily-compact-v1"\)/, "The rules engine and puzzle data load only when Daily is opened");
  for (const mode of ["Trainer", "Rush", "Streak", "Battle"]) assert.match(html, new RegExp(`data-real-mode="${mode}"`));
  assert.match(app, /import\("\.\/vendor\/chess\.js-1\.0\.0\.mjs"\)/);
  assert.match(app, /daily-puzzles-original\.v1\.json\?v=daily-original-v2/);
  assert.match(app, /catalog\.puzzles\.length < 30/, "the browser refuses to load a short or stale pack");
  assert.match(app, /const puzzles = catalog\.puzzles;/);
  assert.match(app, /function currentDayPuzzle\(\)\s*\{\s*const selected = selectDailyPuzzle\(dayKey, puzzles\);\s*const validated = selected \? validatePuzzle\(selected\) : null;/, "runtime performs full chess validation only for today's selected position");
  assert.match(app, /const squareButtons = new Map\(\);[\s\S]*?squareButtons\.set\(square, button\)[\s\S]*?nodes\.some\(\(button, index\) => elements\.board\.children\[index\] !== button\)[\s\S]*?elements\.board\.replaceChildren\(\.\.\.nodes\)/, "the board reuses square controls across moves and only replaces their order when a new day's orientation changes");
  assert.match(app, /elements\.side\.textContent = game\.isCheckmate\(\) \? "Checkmate" : `\$\{game\.turn\(\) === "w" \? "White" : "Black"\} to move`/, "The board status reflects the FEN side to move instead of a white-only placeholder");
  assert.doesNotMatch(app, /supabase|settle_player_progression|player_progression/i);
  assert.match(coreSource, /nschess\.dailyPuzzle\.v1/);
  assert.match(app, /no XP, rating, coins, or account reward/i);
  const shell = worker.slice(worker.indexOf("const APP_SHELL"), worker.indexOf('self.addEventListener("install"'));
  assert.doesNotMatch(shell, /daily-puzzle|daily-puzzles-original|chess\.js-1\.0\.0\.mjs/, "Daily catalog and chess engine are not forced into every install's critical shell");
  assert.match(worker, /const CACHE_NAME = "nschess-shell-v196-mobile-workspace"/);
  assert.match(worker, /assets\/app\.css\?v=mobile-workspace-v1/, "the install-time offline shell caches the same stylesheet version requested by the page");
  assert.match(worker, /caches\.match\(request\)\.then\(\(cached\) => cached \|\| fetch\(request\)[\s\S]*?savePublicAsset\(request, copy\)/, "Daily module, existing chess engine, and catalog are cached after first online request for later offline use");
  assert.match(worker, /function savePublicAsset[\s\S]*?cache\.put\(request, response\)/);

  console.log(`Daily Puzzle regression passed: ${catalog.puzzles.length} original positions verified; date selection, legal objectives, recovery, replay, streaks, and local-only boundaries passed.`);
}

function pathToFileURL(filePath) {
  const url = require("node:url").pathToFileURL(filePath);
  return url.href;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
