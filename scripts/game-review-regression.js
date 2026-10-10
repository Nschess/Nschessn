#!/usr/bin/env node
/*
 * Phase F review-loop regression.
 *
 * Game Review lives inside the browser application closure and depends on the
 * chess engine, Stockfish worker, and auth lifecycle.  These checks therefore
 * inspect the real production function boundaries instead of reimplementing a
 * second review model.  Browser rendering/responsive coverage remains in
 * review-fullscreen-regression.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function section(startNeedle, endNeedle) {
  const start = app.indexOf(startNeedle);
  assert(start >= 0, `missing production section: ${startNeedle}`);
  const end = endNeedle ? app.indexOf(endNeedle, start) : app.length;
  assert(end > start, `missing production section end: ${endNeedle}`);
  return app.slice(start, end);
}

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const provenance = section("function normalizeReviewProvenance", "function getReviewLearningSignal");
const learningSignal = section("function getReviewLearningSignal", "const reviewQualityMeta");
const friendSnapshot = section("function getFriendCanonicalReviewSnapshot", "function getSyncedFriendMoves");
const friendApply = section("function applyRemoteFriendChallenge", "function getFriendInviteLink");
const snapshot = section("function getReviewAnalysisSnapshot", "function openPostGameReview");
const reviewBuilder = section("async function buildMatchReview", "function saveActiveMatchReview");
const reviewRenderer = section("function renderPremiumReview", "function renderReviewMoveHistory");
const reviewGrowth = section("function renderReviewGrowthTrail", "function cancelActiveReviewAnalysis");
const navigation = section("function suspendGameReviewWorkspaceForNavigation", "function exitGameReview");
const accountHydration = section("function hydrateAccountWorkspaceRuntimeState", "let adventureBossMessage");
const postGame = section("function completeCoachGame", "function renderCoachCaptured");

check("review provenance distinguishes local and server-synced games", () => {
  assert.match(provenance, /source === "server-authoritative"/);
  assert.match(provenance, /label: "Server-synced game"/);
  assert.match(provenance, /label: "Local game review"/);
  assert.match(provenance, /Local only · no Elo or canonical progress changes/);
  assert.match(friendSnapshot, /source: "server-authoritative"/);
  assert.match(snapshot, /provenance: \{ source: "server-authoritative"/);
  assert.match(snapshot, /provenance: \{ source: "local"/);
});

check("review uses a stable nine-skill learning taxonomy", () => {
  const keys = [...app.matchAll(/\{ key: "([^"]+)", label: "/g)].map((match) => match[1]);
  const expected = ["foundations", "piece_activity", "opening_principles", "king_safety", "piece_safety", "tactics", "pawn_play", "endgames", "mating_patterns"];
  expected.forEach((key) => assert(keys.includes(key), `missing skill ${key}`));
  assert.match(learningSignal, /engineVerified/);
  assert.match(app, /key: "tactics", label: "Tactics & calculation"/);
});

check("review recommendations route to existing practice surfaces", () => {
  assert.match(reviewRenderer, /practiceRecommendation\.href = useLessonPath \? "#paths" : "#puzzles"/);
  assert.match(reviewRenderer, /dataset\.siteTab = "paths"/);
  assert.match(reviewRenderer, /existing \$\{learningSignal\.key === "tactics" \? "Trainer" : "lesson path"\}/);
  assert.match(html, /id="reviewPracticeRecommendation"/);
});

check("critical moments are bounded and derived from reviewed moves", () => {
  assert.match(reviewBuilder, /const criticalMoments =/);
  assert.match(reviewBuilder, /\.slice\(0, 3\)/);
  assert.match(reviewBuilder, /fenBefore/);
  assert.match(reviewBuilder, /fenAfter/);
  assert.match(reviewBuilder, /replay\.move\(move\.san\)/);
});

check("local review cannot settle canonical XP or rating", () => {
  assert.doesNotMatch(reviewBuilder, /settlePlayerProgression/);
  assert.doesNotMatch(reviewBuilder, /addPuzzleXp/);
  assert.doesNotMatch(snapshot, /settlePlayerProgression/);
  assert.match(postGame, /recordCoachGameResult/);
  assert.match(provenance, /Local only · no Elo or canonical progress changes/);
});

check("review analysis is cancellable on route changes", () => {
  assert.match(navigation, /cancelActiveReviewAnalysis\("Review route changed"\)/);
  assert.match(navigation, /reviewRequestedPgn = ""/);
  assert.match(navigation, /restoreGameReviewWorkspace/);
  assert.match(reviewBuilder, /if \(!isCurrent\(\)\) return null/);
});

check("account switches invalidate in-memory review ownership", () => {
  assert.match(accountHydration, /cancelActiveReviewAnalysis\("Account workspace changed"\)/);
  assert.match(accountHydration, /activeMatchReview = null/);
  assert.match(accountHydration, /reviewRequestedPgn = ""/);
  assert.match(accountHydration, /reviewSelfAnalysisState = null/);
  assert.match(accountHydration, /completedGameSignature = ""/);
  assert.match(accountHydration, /coachGameRecorded = false/);
  assert.match(friendApply, /needsCompletedDecision/);
  assert.match(friendApply, /unchanged && !boardNeedsRestore && !needsCompletedDecision/);
});

check("server-authored friend review keeps completion provenance", () => {
  assert.match(friendSnapshot, /serverRevision/);
  assert.match(friendSnapshot, /authority: "server"/);
  assert.match(snapshot, /friendChallengeState\.status === "completed"/);
});

check("review presentation states its authority boundary", () => {
  assert.match(reviewRenderer, /panel\.dataset\.reviewProvenance = provenance\.source/);
  assert.match(reviewRenderer, /panel\.dataset\.reviewCanonical = String\(provenance\.canonical\)/);
  assert.match(reviewRenderer, /provenance\.label/);
  assert.match(reviewRenderer, /provenance\.note/);
  assert.match(reviewGrowth, /server-synced|local/);
});

check("engine remains optional and review is guarded by stale tokens", () => {
  assert.match(app, /loadStockfish/);
  assert.match(app, /reviewAnalysisToken/);
  assert.match(section("function ensurePostGameReview", "function buildCoachMistakeNote"), /reviewAnalysisToken !== token/);
  assert.match(section("function ensurePostGameReview", "function buildCoachMistakeNote"), /reviewRequestedPgn !== pgn/);
});

check("review route and responsive workspace remain present", () => {
  assert.match(html, /id="gameReview"/);
  assert.match(html, /id="gameReviewWorkspace"/);
  assert.match(app, /function mountGameReviewWorkspace/);
  assert.match(app, /function restoreGameReviewWorkspace/);
  assert.match(fs.readFileSync(path.join(root, "assets", "app.css"), "utf8"), /#gameReview\.is-review-page/);
});

check("engine scores and centipawn loss fail closed", () => {
  assert.match(section("function parseStockfishInfo", "function handleStockfishLine"), /analysis\.hasScore = true/);
  assert.match(section("async function analyzeFenWithStockfish", "const puzzleVerificationConfig"), /hasScore: false/);
  assert.match(section("async function buildMatchReview", "function saveActiveMatchReview"), /before\?\.hasScore === true && after\?\.hasScore === true/);
  assert.match(section("async function buildMatchReview", "function saveActiveMatchReview"), /getReviewCpLoss\(move, before, after\)/);
  assert.match(section("async function buildMatchReview", "function saveActiveMatchReview"), /const cpLoss = engineVerified \? getReviewCpLoss\(move, before, after\) : null/);
  assert.match(app, /reviewAnalysisSchemaVersion = 2/);
  assert.match(section("async function analyzeFenWithStockfish", "const puzzleVerificationConfig"), /review-v\$\{reviewAnalysisSchemaVersion\}/);
});

check("review metrics no longer present uncalibrated accuracy percentages", () => {
  const builder = section("async function buildMatchReview", "function saveActiveMatchReview");
  const dashboard = section("function renderReviewDashboard", "function renderReviewGrowthTrail");
  const postGameMetrics = section("function getPostGameReviewMetrics", "function configurePostGameDecisionActions");
  assert.doesNotMatch(builder, /accuracyFromLosses|whiteAccuracy|blackAccuracy/);
  assert.match(builder, /whiteAverageCentipawnLoss/);
  assert.match(dashboard, /getReviewMetricSummary\(review/);
  assert.match(dashboard, /scoreRing\.style\.setProperty\("--review-score", "0%"\)/);
  assert.match(html, /Avg\. CP loss/);
  assert.match(dashboard, /not a standardized accuracy rating/);
  assert.doesNotMatch(dashboard, /playerAccuracy|performanceScore|tacticsScore/);
  assert.match(postGameMetrics, /engineCoverage/);
  assert.match(html, /<dt>Engine checks<\/dt>/);
  assert.match(html, /Average CP loss by side/);
});

check("saved reviews validate legal replay and stale analyses refresh", () => {
  assert.match(section("function createValidatedReviewGame", "function openSavedMatchReview"), /move\.fenBefore/);
  assert.match(section("function createValidatedReviewGame", "function openSavedMatchReview"), /move\.fenAfter/);
  assert.match(section("function createValidatedReviewGame", "function openSavedMatchReview"), /applied\.san !== move\.san/);
  assert.match(section("function openSavedMatchReview", "function togglePostGameHistory"), /reviewModelVersion/);
  assert.match(section("function openSavedMatchReview", "function togglePostGameHistory"), /force: true/);
});

check("review navigation exposes only available moves and playback", () => {
  assert.match(section("function syncReviewNavigationControls", "function showReviewAnalysisError"), /previous\.disabled = moves\.length < 2 \|\| reviewReplayIndex <= 0/);
  assert.match(section("function syncReviewNavigationControls", "function showReviewAnalysisError"), /next\.disabled = moves\.length < 2 \|\| reviewReplayIndex >= moves\.length - 1/);
  assert.match(section("function stepReview", "function jumpReviewMistake"), /nextIndex < 0 \|\| nextIndex >= activeMatchReview\.moves\.length/);
});

check("unavailable evaluation and best-move summaries fail closed", () => {
  const builder = section("async function buildMatchReview", "function saveActiveMatchReview");
  const renderReview = section("function renderPremiumReview", "function renderReviewSelfAnalysisControls");
  const growth = section("function renderReviewGrowthTrail", "function cancelActiveReviewAnalysis");
  const evaluationRail = section("function updateReviewEvalRail", "function formatReviewAnalysisRemaining");
  assert.match(builder, /Stockfish was unavailable; move quality was not rated/);
  assert.match(builder, /No engine-verified best move is available/);
  assert.match(renderReview, /Practice candidate · not engine-rated/);
  assert.match(renderReview, /not an engine verdict/);
  assert.match(growth, /move reliability cannot be estimated/);
  assert.match(evaluationRail, /Engine evaluation unavailable; no position balance is inferred/);
  assert.match(evaluationRail, /rail\.dataset\.evaluationAvailable = String\(hasEngineScore\)/);
});

function productionHelperSource() {
  return [
    "const reviewAnalysisSchemaVersion = 2;",
    section("function moveToReviewUci", "function getMoveFromFenUci"),
    section("function getReviewCpLoss", "function getReviewPhase"),
    section("function classifyReviewMove", "function getReviewPieceAttacks"),
    section("function buildReviewExplanation", "function getReviewMoveText")
  ].join("\n");
}

const reviewHelpers = vm.runInNewContext(
  `${productionHelperSource()}\n({ classifyReviewMove, getReviewCpLoss, getReviewMetricSummary, buildReviewExplanation })`,
  Object.create(null)
);

const bestMomentHelper = vm.runInNewContext(
  `const coachPlayerColor = "w";
   function getReviewPlayerColor() { return coachPlayerColor; }
   ${section("function getReviewBestMoment", "function getReviewEngineConfidence")}
   getReviewBestMoment`,
  Object.create(null)
);

check("production classifier separates rule facts from engine judgments", () => {
  const ordinaryMove = { from: "e2", to: "e4", san: "e4" };
  assert.equal(reviewHelpers.classifyReviewMove({ move: ordinaryMove, opening: "Ruy Lopez", legalCount: 20, engineVerified: false }), "Unverified");
  assert.equal(reviewHelpers.classifyReviewMove({ move: { from: "h5", to: "h7", san: "Qh7#" }, legalCount: 1, engineVerified: false }), "Checkmate");
  assert.equal(reviewHelpers.classifyReviewMove({ move: ordinaryMove, legalCount: 1, engineVerified: false }), "Forced");
  assert.equal(reviewHelpers.classifyReviewMove({ move: ordinaryMove, bestMove: ordinaryMove, cpLoss: 0, legalCount: 20, engineVerified: true, tactic: "fork" }), "Best");
  assert.equal(reviewHelpers.classifyReviewMove({ move: ordinaryMove, bestMove: { from: "d2", to: "d4", san: "d4" }, cpLoss: null, legalCount: 20, engineVerified: true }), "Unrated");
});

check("production CP loss uses White POV and excludes missing or mate scores", () => {
  const score = (scoreCp, mate = null, hasScore = true) => ({ scoreCp, mate, hasScore });
  assert.equal(reviewHelpers.getReviewCpLoss({ color: "w" }, score(100), score(-50)), 150);
  assert.equal(reviewHelpers.getReviewCpLoss({ color: "b" }, score(100), score(250)), 150);
  assert.equal(reviewHelpers.getReviewCpLoss({ color: "w" }, score(100), score(250, null, false)), null);
  assert.equal(reviewHelpers.getReviewCpLoss({ color: "w" }, score(1000, 2), score(-1000, -1)), null);
});

check("production metrics count engine coverage and ignore legacy percentages", () => {
  const review = {
    analysis: { reviewModelVersion: 2 },
    whiteAccuracy: 99,
    moves: [
      { color: "w", engineVerified: true, cpLoss: 20 },
      { color: "w", engineVerified: true, cpLoss: null },
      { color: "b", engineVerified: false, cpLoss: null }
    ]
  };
  const white = reviewHelpers.getReviewMetricSummary(review, "w");
  assert.equal(white.checkedMoves, 2);
  assert.equal(white.totalMoves, 2);
  assert.equal(white.centipawnScoredMoves, 1);
  assert.equal(white.averageCentipawnLoss, 20);
  assert.equal(reviewHelpers.getReviewMetricSummary({ whiteAccuracy: 99, moves: review.moves }, "w"), null);
  assert.match(reviewHelpers.buildReviewExplanation({}, "Unverified"), /did not return enough complete score data/);
  assert.match(reviewHelpers.buildReviewExplanation({}, "Checkmate"), /rules confirm/);
});

check("production best-move selection never promotes unverified moves", () => {
  const unverified = { color: "w", label: "Unverified", engineVerified: false, cpLoss: null };
  const verifiedBest = { color: "w", label: "Best", engineVerified: true, cpLoss: 0 };
  const noBest = bestMomentHelper({ moves: [unverified] });
  assert.equal(noBest.index, -1);
  assert.equal(noBest.move, null);
  assert.equal(bestMomentHelper({ moves: [unverified, verifiedBest] }).move, verifiedBest);
  assert.equal(bestMomentHelper({ moves: [{ color: "w", label: "Checkmate", engineVerified: false }] }).move.label, "Checkmate");
});

const { pathToFileURL } = require("node:url");
async function checkStoredReviewReplay() {
  const { Chess } = await import(pathToFileURL(path.join(root, "assets", "vendor", "chess.js-1.0.0.mjs")).href);
  const moveToReviewUci = vm.runInNewContext(
    `${section("function moveToReviewUci", "function getMoveFromFenUci")}\nmoveToReviewUci`
  );
  const createValidatedReviewGame = vm.runInNewContext(
    `const CoachChess = Chess;\n${section("function createValidatedReviewGame", "function openSavedMatchReview")}\ncreateValidatedReviewGame`,
    { Chess, moveToReviewUci }
  );
  const game = new Chess();
  const moves = [];
  for (const san of ["e4", "e5"]) {
    const fenBefore = game.fen();
    const move = game.move(san);
    moves.push({ from: move.from, to: move.to, san: move.san, promotion: "", fenBefore, fenAfter: game.fen() });
  }
  const review = { moves, fen: game.fen(), pgn: game.pgn() };
  check("production saved-review replay validates legal moves and FEN transitions", () => {
    const replay = createValidatedReviewGame(review);
    assert(replay);
    assert.equal(replay.fen(), game.fen());
    assert.equal(replay.history().length, 2);
    assert.equal(createValidatedReviewGame({ ...review, moves: [{ ...moves[1], fenBefore: moves[0].fenBefore }] }), null);
    assert.equal(createValidatedReviewGame({ ...review, moves: [{ ...moves[0], to: "e5" }, moves[1]] }), null);
    assert.equal(createValidatedReviewGame({ ...review, pgn: "1. d4 d5 *" }), null);
  });
}

checkStoredReviewReplay()
  .then(() => console.log("Game review regression complete."))
  .catch((error) => {
    console.error(`FAIL production saved-review replay import: ${error.message}`);
    process.exitCode = 1;
  });
