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

console.log("Game review regression complete.");
