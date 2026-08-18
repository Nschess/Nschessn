/*
 * Static regression contracts for the shared board interaction lifecycle.
 *
 * The browser harness owns pointer/touch execution; this script protects the
 * architecture that makes those paths safe across route changes and cache
 * updates without duplicating the application runtime in Node.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("assets/app.js");
const css = read("assets/app.css");
const perfLiteCss = read("assets/routes/perf-lite.css");
const html = read("index.html");
const worker = read("service-worker.js");
const deployment = read("docs/DEPLOYMENT-CHECKLIST.md");

const requiredAppContracts = [
  ["one-registration map", /const registrations = new WeakMap\(\)/],
  ["active registration set", /const activeRegistrations = new Set\(\)/],
  ["route cancellation API", /cancelAll\(event = null\)/],
  ["route cancellation call", /boardInteractionEngine\.cancelAll\(\{ type: "routechange" \}\)/],
  ["drag safety timer", /dragSafetyTimer/],
  ["blur cleanup", /window\.addEventListener\("blur", onWindowBlur\)/],
  ["visibility cleanup", /document\.addEventListener\("visibilitychange", onVisibilityChange\)/],
  ["Escape shared release", /shared release path so Escape also clears pointer/],
  ["Adventure square identity", /square\.dataset\.square = name/],
  ["Play analysis opt-in", /return reviewPageActive \|\| !liveFriendGame/],
  ["Play overlay preservation", /controller\?\.render\(\[\], \[\]\)/],
  ["Play move annotation helper", /function clearCoachTemporaryAnalysis\(\)[\s\S]*?clearAnalysisUserOverlay\(board\)/],
  ["Committed move annotation clear", /function makeCoachMove\([\s\S]*?if \(!move\) \{[\s\S]*?return false;\s*\}\s*\n\s*clearCoachTemporaryAnalysis\(\);/],
  ["Bot move annotation clear", /const move = safeReply && coachGame\.move\([\s\S]*?if \(move\) \{\s*clearCoachTemporaryAnalysis\(\);/],
  ["Premove turn guard", /function queueCoachPremove\(from, to = ""\)[\s\S]*?coachGame\.turn\(\) === coachPlayerColor\) return false/],
  ["Premove revalidation", /function tryRunCoachPremove\(\)[\s\S]*?moves\(\{ square: queued\.from, verbose: true \}\)/],
  ["Remote premove wake-up", /const remotePositionChanged = Boolean\([\s\S]*?const canCheckPremove = remote\.status === "active"[\s\S]*?tryRunCoachPremove\(\)/],
  ["Idle lifecycle premove cleanup", /onLifecycleCancel\(\)[\s\S]*?isLivePremoveEnabled\(\)[\s\S]*?cancelCoachPremove\(\)/],
  ["Route premove cleanup", /boardInteractionEngine\.cancelAll\(\{ type: "routechange" \}\);\s*cancelCoachPremove\(\);/]
];
requiredAppContracts.forEach(([name, pattern]) => {
  assert.match(app, pattern, `Missing board lifecycle contract: ${name}`);
});
const makeCoachMoveBody = app.slice(app.indexOf("function makeCoachMove("), app.indexOf("function handleCoachSquare("));
const committedClearIndex = makeCoachMoveBody.indexOf("clearCoachTemporaryAnalysis();");
assert.ok(committedClearIndex > 0, "Play move path does not clear committed annotations");
assert.doesNotMatch(makeCoachMoveBody.slice(0, committedClearIndex), /clearCoachTemporaryAnalysis\(\)/, "Illegal/cancelled Play moves must not clear annotations");
const premoveBody = app.slice(app.indexOf("function tryRunCoachPremove("), app.indexOf("function getTournamentProvider("));
assert.match(premoveBody, /const queued = \{ \.\.\.coachPremove \};\s*coachPremove = null[\s\S]*?if \(!legalMove\) \{[\s\S]*?return false;[\s\S]*?return makeCoachMove\(/, "Premove must clear before one-shot execution and cancel invalid moves");
assert.match(app, /function completeCoachGame\([\s\S]*?coachPremove = null/, "Game end must clear queued premoves");
assert.match(css, /\.play-board > \.review-arrow-layer/, "Analysis layer is not scoped to the board");
assert.match(css, /\.review-arrow-layer[\s\S]*background: transparent !important/, "Analysis layer must stay transparent");
assert.doesNotMatch(perfLiteCss, /body\.perf-lite\s+:where\([^)]*\.review-arrow-layer/, "perf-lite must not hide functional analysis arrows");

assert.equal((app.match(/window\.addEventListener\("blur", onWindowBlur\)/g) || []).length, 1, "Duplicate blur listener registration");
assert.equal((app.match(/document\.addEventListener\("visibilitychange", onVisibilityChange\)/g) || []).length, 1, "Duplicate visibility listener registration");
assert.match(app, /activeRegistrations\.delete\(registration\)/, "Detached boards must leave the active registration set");

const cacheName = "nschess-shell-v133-play-premove";
const cacheVersion = "review-v133-play-premove";
assert.match(html, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "HTML does not use the v133 asset version");
assert.match(app, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Lazy route loaders do not use the v133 asset version");
assert.match(worker, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker shell assets do not use the v133 asset version");
assert.match(worker, new RegExp(cacheName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker cache name is not v133");
[
  ["index.html", html],
  ["assets/app.js", app],
  ["service-worker.js", worker],
  ["docs/DEPLOYMENT-CHECKLIST.md", deployment]
].forEach(([file, source]) => {
  assert.doesNotMatch(source, /review-v129-interaction-polish|nschess-shell-v129-interaction-polish/, `${file} retains a stale deployment cache identifier`);
});

console.log("board-interaction-regression: lifecycle and cache contracts passed");
