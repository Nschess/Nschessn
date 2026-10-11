#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "assets", "app.css"), "utf8");

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `missing production contract: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing production contract end: ${endNeedle}`);
  return source.slice(start, end);
}

function executeFunction(source, functionSource, args, globals = {}) {
  const context = { ...globals, input: args, output: null };
  vm.runInNewContext(`${functionSource}\noutput = ${functionSource.match(/function\s+([\w$]+)/)[1]}(...input);`, context);
  return JSON.parse(JSON.stringify(context.output));
}

const normalizeSource = between(app, "function normalizeSupabaseProfileData(", "function createSupabaseAuthProvider(");
const profileMetricsSource = between(app, "function getProfileServerStatistics(", "function getProfileLocalPracticeStatistics(");
const localPracticeSource = between(app, "function getProfileLocalPracticeStatistics(", "function formatAccountDate(");
const playerRenderer = between(app, "function renderPlayerProfile()", "function renderProfileRatingHistory()");
const showcaseRenderer = between(app, "function renderProfileShowcase(", "function getLearnerPuzzleRating()");
const historyRenderer = between(app, "function renderProfileRatingHistory()", "function renderProfileShowcase(");

function normalize(profile) {
  return executeFunction(normalizeSource, normalizeSource, [profile], { normalizeCountryFlagValue: (value) => value || "" });
}

function serverStats(profile, authenticated = true) {
  return executeFunction(profileMetricsSource, profileMetricsSource, [profile, authenticated]);
}

function localStats(state) {
  const result = executeFunction(localPracticeSource, localPracticeSource, [true], {
    isApplicationAuthenticated: () => true,
    puzzleAttempts: state.attempts,
    puzzleCorrect: state.correct,
    puzzleFailed: state.failed,
    solvedPuzzles: new Set(state.solved || []),
    bestPuzzleStreak: state.bestStreak || 0,
    getPuzzleAccuracy: () => state.accuracy,
    getLearnerPuzzleRating: () => state.score
  });
  return result;
}

const missing = normalize({ username: "Example" });
assert.equal(missing.rating, 450, "legacy callers retain their established normalized fallback");
assert.equal(missing.profileMetricAvailability.rating, false, "fallback rating is not mistaken for a profile fact");
assert.equal(missing.profileMetricAvailability.wins, false);
assert.equal(serverStats(missing).gameRating, null, "missing authoritative rating fails closed");
assert.equal(serverStats(missing).gamesPlayed, null, "missing record totals do not become zero games");
assert.equal(serverStats(missing).coins, null, "missing wallet data is not shown as an empty balance");

const accountA = normalize({ rating: 1520, coins: 73, xp: 840, wins: 3, losses: 1, draws: 1 });
assert.deepEqual(serverStats(accountA), {
  gameRating: 1520, coins: 73, xp: 840, wins: 3, losses: 1, draws: 1, gamesPlayed: 5, winRate: 60
});
assert.deepEqual(serverStats(accountA, false), {
  gameRating: null, coins: null, xp: null, wins: null, losses: null, draws: null, gamesPlayed: null, winRate: null
}, "guest/loading cannot reuse a prior authenticated profile snapshot");

const newAccount = normalize({ rating: 1170, coins: 0, xp: 0, wins: 0, losses: 0, draws: 0 });
assert.equal(serverStats(newAccount).gameRating, 1170, "account switch reads only the newly supplied profile row");
assert.equal(serverStats(newAccount).gamesPlayed, 0, "a known zero-game record is distinct from missing fields");
assert.equal(serverStats(newAccount).winRate, null, "zero games do not claim a fabricated 0% win rate");
assert.equal(serverStats(normalize({ rating: 1520, wins: 2, losses: 0, draws: 0.5 })).gamesPlayed, null,
  "malformed fractional match counts fail closed");
assert.equal(serverStats(normalize({ rating: "invalid", wins: 1, losses: 0, draws: 0 })).gameRating, null,
  "invalid ratings are unavailable rather than normalized fallback values");
assert.equal(serverStats(normalize({ rating: 3001 })).gameRating, null,
  "ratings outside the profile schema range fail closed");
assert.equal(serverStats(normalize({ rating: true, coins: false, wins: true, losses: 0, draws: 0 })).gameRating, null,
  "booleans are not coerced into authoritative numeric facts");
assert.equal(serverStats(normalize({ rating: 900, wins: Number.MAX_SAFE_INTEGER, losses: 1, draws: 0 })).gamesPlayed, null,
  "overflowing totals fail closed");

assert.deepEqual(localStats({ attempts: 0, correct: 0, failed: 0, accuracy: 0, score: 400 }), {
  attempts: 0, solved: 0, accuracy: null, bestStreak: null, score: null
}, "no practice means no invented baseline score or 0% accuracy");
assert.deepEqual(localStats({ attempts: 2, correct: 1, failed: 1, solved: [2], accuracy: 50, bestStreak: 1, score: 426 }), {
  attempts: 2, solved: 1, accuracy: 50, bestStreak: 1, score: 426
});

assert.match(playerRenderer, /getProfileServerStatistics\(\)/);
assert.doesNotMatch(playerRenderer, /getLearnerGameRating\(\)|gameStats\./,
  "profile presentation cannot fall back to local game rating or match counters");
assert.match(playerRenderer, /getProfileLocalPracticeStatistics\(authenticated\)/);
assert.match(playerRenderer, /\[data-profile-field="xp"\].*serverStats\.xp/,
  "account XP uses the authenticated profile field, not device-derived practice XP");
assert.match(playerRenderer, /serverStats\.gameRating === null \? "—"/);
assert.match(playerRenderer, /serverStats\.winRate === null \? "—"/);
assert.match(playerRenderer, /on this device/);
assert.match(app, /profileData: normalizeSupabaseProfileData\(\{ \.\.\.\(account\.profileData \|\| \{\}\), \.\.\.row, \.\.\.\(saved \|\| \{\}\) \}\)/,
  "profile edits preserve already-hydrated account facts when the update response omits them");
assert.doesNotMatch(showcaseRenderer, /recordedWins|recordedDraws|recordedLosses|gameStats\./,
  "the account match record is not reconstructed from local reviews or gameStats");
assert.match(showcaseRenderer, /metric\(serverStats\.wins, "Account wins"/);
assert.match(showcaseRenderer, /metric\(practiceStats\.accuracy, "Accuracy · device"/);
assert.doesNotMatch(showcaseRenderer, /Reward:|collection\.reward\?\.label/,
  "profile milestones and collection progress do not claim locally minted rewards");
assert.match(historyRenderer, /if \(!points\.length\)/);
assert.match(historyRenderer, /No local puzzle practice yet/);
assert.match(historyRenderer, /latestPracticeScore = currentRating \?\? points\.at\(-1\)\?\.rating \?\? null/);
assert.match(historyRenderer, /latest estimate/);
assert.doesNotMatch(historyRenderer, /formatProfileNumber\(currentRating\)`?\s*current/,
  "empty history cannot turn a missing score into a displayed zero");
assert.doesNotMatch(historyRenderer, /puzzle rating trend|Current puzzle rating/i);

assert.match(html, /Game rating · account/);
assert.match(html, /Puzzle practice estimate · this device/);
assert.match(html, /Practice estimate · this device, not Elo/);
assert.match(html, /On this device · no server rewards/);
assert.match(html, /timed season or server achievement/);
assert.doesNotMatch(html, /data-profile-field="gameRating">(?:450|600|400)|data-profile-field="puzzleRating">400|data-profile-field="winRate">0%/,
  "static pre-hydration markup contains no fabricated rating, practice score, or win rate");
assert.doesNotMatch(html, /data-profile-field="progress">0%|data-profile-field="next">Next Level: 80 XP|data-profile-field="level">Level 1 Explorer/,
  "static pre-hydration markup contains no fabricated level, progress, or next-level claim");
assert.doesNotMatch(html, /data-account-field="title">Explorer|data-account-field="joinDate">Today|data-account-field="lastLogin">Today/,
  "static pre-hydration account details do not invent rank or dates");
assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.login-player-profile \.profile-command-grid/,
  "the existing compact single-column small-screen treatment remains in place");

const authReset = between(app, "function resetApplicationAccountState(", "function applyAuthenticatedAccount(");
assert.match(authReset, /applicationAuthAccount = null/);
assert.match(authReset, /applicationAuthState = status === "error" \? "error" : status === "loading" \? "loading" : "guest"/);

console.log("PASS: profile facts use presence-aware authenticated profile data");
console.log("PASS: guest, missing, malformed, zero-game, and account-switch cases fail closed");
console.log("PASS: device-local practice and milestones are not presented as server ratings/rewards");
console.log("PASS: profile history and small-screen layout contracts remain truthful and compact");
