const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function findClosingBracket(source, start, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Could not find matching ${closeChar} in production source.`);
}

function extractArrayAfter(marker) {
  const markerIndex = app.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Production catalog marker is present: ${marker}`);
  const start = app.indexOf("[", markerIndex + marker.length - 1);
  assert.notEqual(start, -1, `Production catalog array starts after ${marker}`);
  const end = findClosingBracket(app, start, "[", "]");
  return Function(`return (${app.slice(start, end + 1)});`)();
}

function extractFunction(marker) {
  const start = app.indexOf(marker);
  assert.notEqual(start, -1, `Production function is present: ${marker}`);
  const open = app.indexOf("{", start + marker.length - 1);
  const end = findClosingBracket(app, open, "{", "}");
  return app.slice(start, end + 1);
}

function boardPieceAt(placement, square) {
  const target = (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
  let index = 0;
  for (const row of placement.split("/")) {
    for (const cell of row) {
      if (/^[1-8]$/.test(cell)) index += Number(cell);
      else {
        if (index === target) return cell;
        index += 1;
      }
    }
  }
  return "";
}

function getProductionTutorialFen(lesson, steps) {
  const fen = String(lesson.fen || "").trim();
  if (fen.split(/\s+/).length > 1) return fen;
  const firstMove = steps[0] || lesson;
  const sourcePiece = boardPieceAt(fen, firstMove.from);
  const side = lesson.side || (/^[a-z]$/.test(sourcePiece) ? "b" : "w");
  const hasCastle = lesson.special === "castle" || steps.some((move) => move.special === "castle");
  const hasEnPassant = lesson.special === "enpassant" || steps.some((move) => move.special === "enpassant");
  const enPassantTarget = firstMove.correct || firstMove.to || "-";
  return `${fen} ${side} ${hasCastle ? "KQkq" : "-"} ${hasEnPassant ? enPassantTarget : "-"} 0 1`;
}

function getSteps(lesson) {
  if (Array.isArray(lesson.moves) && lesson.moves.length) {
    return lesson.moves.map((move) => ({
      from: move.from,
      correct: move.to || move.correct,
      targets: move.targets || [move.to || move.correct],
      special: move.special,
      promotion: move.promotion || "q"
    }));
  }
  return [{ from: lesson.from, correct: lesson.correct, targets: lesson.targets || [lesson.correct], special: lesson.special, promotion: "q" }];
}

function makeSafeReply(game, expected) {
  const avoid = new Set([expected.from, expected.correct].filter(Boolean));
  const legal = game.moves({ verbose: true });
  const preferred = legal.filter((move) => !avoid.has(move.to) && !avoid.has(move.from) && !move.captured && !move.promotion);
  const alternate = legal.filter((move) => !avoid.has(move.to));
  const seen = new Set();
  const candidates = [...preferred, ...alternate, ...legal].filter((move) => {
    const key = `${move.from}:${move.to}:${move.promotion || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const candidate of candidates) {
    game.move({ from: candidate.from, to: candidate.to, promotion: candidate.promotion });
    const preservesStep = game.get(expected.from)?.color === game.turn()
      && game.moves({ square: expected.from, verbose: true }).some((move) => (
        move.to === expected.correct && (!move.promotion || move.promotion === expected.promotion)
      ));
    game.undo();
    if (preservesStep) return candidate;
  }
  return null;
}

async function run() {
  const chessModule = await import(pathToFileURL(path.join(root, "assets/vendor/chess.js-1.0.0.mjs")).href);
  const Chess = chessModule.Chess || chessModule.default?.Chess || chessModule.default;
  assert.equal(typeof Chess, "function", "The production vendored chess.js engine is available.");

  const lessons = extractArrayAfter("const beginnerTutorialLessons = [");
  const expandMoves = extractFunction("function expandCoreBeginnerTutorialMoves()");
  Function("beginnerTutorialLessons", `${expandMoves}; return beginnerTutorialLessons;`)(lessons);
  const packBuilder = extractFunction("function buildBeginnerTutorialPack()");
  const pack = Function("start", `${packBuilder}; return buildBeginnerTutorialPack();`)("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
  lessons.push(...pack);

  assert.equal(lessons.length, 68, "The supported Learn catalog retains all 68 lesson IDs.");
  assert.equal(new Set(lessons.map((lesson) => lesson.id)).size, 68, "Lesson IDs are unique and completion identity remains stable.");
  const lineFailures = [];
  for (const lesson of lessons) {
    const steps = getSteps(lesson);
    assert.ok(steps.length > 0, `${lesson.id} has at least one real board task.`);
    assert.ok(Array.isArray(lesson.quiz) && lesson.quiz.length === 4, `${lesson.id} has one question and three answer choices.`);
    assert.ok(lesson.answer >= 1 && lesson.answer <= 3, `${lesson.id} answer index is supported.`);
    let game;
    try {
      game = new Chess(getProductionTutorialFen(lesson, steps));
    } catch (error) {
      lineFailures.push(`${lesson.id}: invalid FEN (${error.message})`);
      continue;
    }
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!/^[a-h][1-8]$/.test(step.from) || !/^[a-h][1-8]$/.test(step.correct)) {
        lineFailures.push(`${lesson.id} step ${index + 1}: malformed square.`);
        break;
      }
      if (!step.targets.includes(step.correct)) {
        lineFailures.push(`${lesson.id} step ${index + 1}: the intended move is absent from its target list.`);
        break;
      }
      if (!game.get(step.from)) {
        lineFailures.push(`${lesson.id} step ${index + 1}: the guided source piece is missing.`);
        break;
      }
      if (game.get(step.from).color !== game.turn()) {
        const reply = makeSafeReply(game, step);
        if (!reply) {
          lineFailures.push(`${lesson.id} step ${index + 1}: no legal opponent reply preserves the next task.`);
          break;
        }
        game.move({ from: reply.from, to: reply.to, promotion: reply.promotion });
      }
      const legalMove = game.moves({ square: step.from, verbose: true }).find((move) => (
        move.to === step.correct && (!move.promotion || move.promotion === step.promotion)
      ));
      if (!legalMove) {
        lineFailures.push(`${lesson.id} step ${index + 1}: ${step.from}-${step.correct} is illegal in the reached position.`);
        break;
      }
      const played = game.move({ from: legalMove.from, to: legalMove.to, promotion: legalMove.promotion || "q" });
      if (!played) {
        lineFailures.push(`${lesson.id} step ${index + 1}: chess.js rejected the intended move.`);
        break;
      }
    }
  }
  assert.deepEqual(lineFailures, [], `Every lesson FEN and scripted move sequence is playable: ${lineFailures.join("; ")}`);

  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  assert.equal(byId.get("skewer").badge, "Captures", "A plain rook capture is no longer mislabeled as a skewer.");
  assert.match(byId.get("discovered").coach, /uncovers the bishop's diagonal/i, "The discovered-attack exercise moves the actual blocker.");
  assert.match(byId.get("beginner-quest-remove-defender").title, /open-file rook check/i, "The blocked rook line is replaced with a truthful open-file task.");
  assert.match(byId.get("beginner-quest-pressure-pin").title, /protected check/i, "The check exercise no longer claims a pin that the position does not demonstrate.");
  assert.equal(byId.get("beginner-quest-save-the-king").moves.length, 1, "The king exercise no longer includes a move into an attacked square.");
  assert.match(byId.get("capture").title, /pawn with check/i, "The capture exercise no longer claims it captures the attacking pawn.");
  assert.match(byId.get("check").title, /safe check/i, "The check lesson starts from a position where the opposing king is not already in check.");

  const moveFrom = (lesson, from, to) => {
    const game = new Chess(getProductionTutorialFen(lesson, getSteps(lesson)));
    const move = game.moves({ verbose: true }).find((candidate) => candidate.from === from && candidate.to === to);
    assert.ok(move, `${lesson.id}: ${from}-${to} is a legal authored teaching move`);
    return { game, move };
  };
  {
    const { game, move } = moveFrom(byId.get("capture"), "c4", "f7");
    assert.equal(game.isCheck(), false, "the capture lesson begins with White to move and Black not already checked");
    assert.ok(game.move(move)?.captured, "the capture task really captures the pawn");
    assert.equal(game.isCheck(), true, "the bishop capture really gives check");
    assert.ok(game.attackers("f7", "w").includes("f1"), "the checking bishop is defended by the supporting rook");
  }
  {
    const { game, move } = moveFrom(byId.get("check"), "e2", "b5");
    assert.equal(game.isCheck(), false, "the check example does not begin with Black already in check");
    game.move(move);
    assert.equal(game.isCheck(), true, "the intended queen move creates the check");
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-save-the-king"), "e1", "f1");
    assert.equal(game.isCheck(), true, "the king-safety task begins in actual rook check");
    game.move(move);
    assert.equal(game.isCheck(), false, "the king's legal escape resolves check");
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-block-line"), "d2", "e3");
    assert.equal(game.isCheck(), true, "the interposition task begins with a rook check");
    game.move(move);
    assert.equal(game.isCheck(), false, "the bishop on e3 blocks the checking file");
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-capture-attacker"), "e4", "d5");
    assert.ok(game.attackers("e4", "b").includes("d5"), "the enemy pawn really attacks the white pawn before the defense");
    assert.ok(game.move(move)?.captured, "the response captures and removes that attacker");
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-double-attack-mini"), "f6", "d7");
    assert.equal(game.isCheck(), false, "the fork example starts without the king already checked");
    game.move(move);
    assert.equal(game.isCheck(), true, "the knight fork checks the king");
    assert.equal(game.get("b8")?.type, "q", "the queen remains a second fork target");
    assert.ok(game.attackers("b8", "w").includes("d7"), "the same knight attacks that queen");
    assert.ok(game.attackers("d7", "w").includes("d1"), "the rook protects the checking knight from capture");
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-queen-escape"), "d1", "h5");
    assert.ok(game.attackers("d1", "b").includes("d8"), "the queen is genuinely attacked by the rook");
    game.move(move);
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-save-bishop"), "c4", "b5");
    assert.ok(game.attackers("c4", "b").includes("c8"), "the bishop is genuinely attacked by the rook");
    game.move(move);
  }
  {
    const { game, move } = moveFrom(byId.get("beginner-quest-passed-pawn"), "b6", "b7");
    game.move(move);
    assert.ok(game.attackers("a8", "w").includes("b7"), "the king's escort square protects the pawn's promotion square");
  }
  {
    const lesson = byId.get("beginner-quest-opposition-intro");
    const game = new Chess(getProductionTutorialFen(lesson, getSteps(lesson)));
    assert.equal(game.get("e4")?.type, "k", "the opposition lesson places the white king on the e-file");
    assert.equal(game.get("e6")?.type, "k", "the opposition lesson places the kings directly opposed with one square between them");
    assert.equal(game.turn(), "w", "the player to move faces the opposition lesson position");
  }

  const storageFunction = extractFunction("function readBeginnerTutorialState()");
  const catalogIds = lessons.map((lesson) => lesson.id);
  const readState = (payload) => Function(
    "beginnerTutorialLessons", "beginnerTutorialStorageKey", "readJsonStorage",
    `${storageFunction}; return readBeginnerTutorialState();`
  )(lessons, "learn-regression", (_key, fallback) => payload === undefined ? fallback : payload);
  const corrupted = readState({
    current: 999,
    completed: ["setup", "removed-lesson", null],
    rewarded: { invalid: true },
    achievements: ["Board Builder", "fabricated badge"],
    voice: "on",
    coords: 0,
    flipped: true
  });
  assert.equal(corrupted.current, 67, "Corrupt saved indexes clamp to the final supported lesson.");
  assert.deepEqual(corrupted.completed, ["setup"], "Unsupported/corrupt completion IDs are ignored.");
  assert.deepEqual(corrupted.rewarded, [], "Malformed reward state cannot break lesson hydration.");
  assert.deepEqual(corrupted.achievements, ["Board Builder"], "Unsupported achievements are ignored.");
  assert.equal(corrupted.voice, false, "Voice preferences normalize to booleans.");
  assert.equal(corrupted.coords, true, "Coordinate preferences normalize to booleans.");
  assert.equal(corrupted.flipped, true, "Valid board orientation survives normalization.");
  assert.equal(readState({ current: -4 }).current, 0, "Negative saved indexes clamp to the first lesson.");
  assert.equal(readState(null).current, 0, "A malformed saved object falls back safely.");

  assert.match(app, /function renderTutorialTopicFilter\(\)/, "The lesson rail groups the real catalog by its authored topic labels.");
  assert.match(app, /lessonList\?\.addEventListener\("click"/, "Lesson navigation uses one delegated listener rather than one listener per rendered row.");
  assert.match(app, /function chooseTutorialAutoReply[\s\S]*?preservesNextStep[\s\S]*?return candidate;[\s\S]*?return null;/, "Automatic replies are accepted only when the next expected task remains legal.");
  assert.match(app, /function validateActiveTutorialStep[\s\S]*?Restart this lesson[\s\S]*?function syncTutorialTurn/, "An invalid/missing task fails closed instead of silently incrementing lesson progress.");
  assert.doesNotMatch(app.slice(app.indexOf("function validateActiveTutorialStep"), app.indexOf("function syncTutorialTurn")), /tutorialMoveStep\s*\+\+/, "Step validation cannot silently skip an exercise.");
  assert.match(html, /id="tutorialTopicFilter"[\s\S]*?id="tutorialLessonList"/, "The filter and lesson list are accessible controls in the tutorial rail.");
  assert.match(html, /checklist is saved in this browser; it is not a synced course record/i, "Local checklist progress is not presented as a server course record.");
  assert.match(html, /Intermediate, Advanced, and Master are topic roadmaps—not interactive courses yet/i, "Unsupported higher-level course content is labeled honestly.");

  process.stdout.write("PASS Learn regression: 68 production catalog entries, valid playable FEN/move lines, fail-closed task integrity, safe saved-state hydration, accessible topic filtering, and truthful roadmap labeling.\n");
}

run().catch((error) => {
  process.stderr.write(`FAIL Learn regression: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
