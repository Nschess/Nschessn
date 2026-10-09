/* Production-baseline contract: the legacy server-backed Daily reward path
 * stays disabled until rights-cleared account content is explicitly approved. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Production function ${name} must remain present for verification.`);
  const close = app.indexOf("\n    }", start);
  assert.notEqual(close, -1, `Production function ${name} must remain closed.`);
  return app.slice(start, close + "\n    }".length);
}

assert.match(app, /const dailyPuzzleLaunchEnabled = false;/, "The compatibility build must keep the rights-gated Daily feature disabled by default.");
assert.match(app, /function getDailyPuzzleIndex\(\) \{\s*if \(!dailyPuzzleLaunchEnabled \|\|/, "Daily assignment selection must fail closed before choosing a date-derived puzzle.");
assert.match(app, /function completeDailyHabit\(\) \{\s*const today = getTodayKey\(\);\s*if \(!dailyPuzzleLaunchEnabled \|\|/, "A disabled Daily puzzle must not mint the old local Daily-habit reward.");

const dailyIndex = new Function("puzzles", "dailyPuzzleLaunchEnabled", `${functionSource("getDailyPuzzleIndex")}; return getDailyPuzzleIndex();`);
assert.equal(dailyIndex([{ id: "practice-only" }], false), -1, "Disabled Daily selection must not return a practice puzzle index.");

let xpAwarded = 0;
const savedHabit = { streak: 4, lastDate: "2026-10-08", rewardDate: "" };
const completeHabit = new Function(
  "dailyPuzzleLaunchEnabled", "dailyHabit", "getTodayKey", "getDayDistance", "addPuzzleXp",
  `${functionSource("completeDailyHabit")}; return completeDailyHabit();`
);
assert.equal(completeHabit(false, savedHabit, () => "2026-10-09", () => 1, (amount) => { xpAwarded += amount; }), false);
assert.deepEqual(savedHabit, { streak: 4, lastDate: "2026-10-08", rewardDate: "" }, "Disabled Daily completion must preserve saved habit data.");
assert.equal(xpAwarded, 0, "Disabled Daily completion must not award local Daily-habit XP.");

assert.match(app, /const realPuzzleModes = \["Trainer", "Rush", "Streak", "Battle"\];/, "Daily must not be an available modern puzzle mode.");
assert.match(app, /const requestedMode = button\.dataset\.realMode \|\| "Trainer";\s*if \(!realPuzzleModes\.includes\(requestedMode\)\) return;/, "Unsupported or stale saved mode events must be rejected.");
assert.match(app, /if \(action === "daily-puzzle"\) \{[\s\S]*?openRealPuzzleExperience\("Trainer"\);/, "Legacy Daily action links must fall safely into ordinary practice.");
assert.match(app, /realPuzzleMode = realPuzzleModes\.includes\(savedRealPuzzleState\.mode\) \? savedRealPuzzleState\.mode : "Trainer";/, "A previously saved Daily mode must hydrate to supported Trainer mode.");
assert.doesNotMatch(html, /data-real-mode="Daily"/, "No selectable Daily mode may remain in the page markup.");
assert.match(html, /id="dailyPuzzle"[^>]*disabled[^>]*>Daily Puzzle unavailable<\/button>/, "The legacy Daily control must be visibly and semantically disabled.");
assert.match(html, /data-daily-puzzle-launch[^>]*aria-pressed="false"[^>]*aria-controls="dailyPuzzlePanel"[^>]*disabled[^>]*aria-disabled="true">Daily · local<\/button>/, "The new Daily mode is a distinct device-local experience, not the old server-backed Daily mode.");
assert.match(html, /id="dailyPuzzlePanel"[^>]*hidden/, "The local Daily interface is not shown until the player enters its mode.");
assert.match(html, /id="dailyPuzzleBadge">Puzzle practice<\/span>/, "The puzzle badge must not flash a Daily label before the practice renderer runs.");
assert.match(html, /id="newToChessButton"[^>]*data-home-action="puzzle-plan"[^>]*><span[\s\S]*?<strong>Puzzle Practice<\/strong>/, "Home's primary puzzle action must offer ordinary practice, not a Daily challenge.");
assert.doesNotMatch(html, /data-home-action="daily-puzzle"|Start daily puzzle|Find today's pattern/, "Home must not advertise a date-selected Daily Puzzle.");
assert.match(app, /badge\.textContent = dailyPuzzleLaunchEnabled && currentPuzzle === getDailyPuzzleIndex\(\) \? getDailyChallengeName\(\) : "Puzzle practice";/, "The puzzle UI must identify every currently selectable puzzle as practice.");
assert.match(app, /dailyReward\.textContent = !dailyPuzzleLaunchEnabled\s*\? "Daily Puzzle is unavailable until a rights-cleared production catalog is approved\."/, "The reward panel must not imply a disabled Daily puzzle can be completed.");

console.log("PASS legacy server-backed Daily rewards remain disabled; local Daily mode is distinct and general puzzle practice is retained");
