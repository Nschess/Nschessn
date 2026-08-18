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
  ["Adventure square identity", /square\.dataset\.square = name/]
];
requiredAppContracts.forEach(([name, pattern]) => {
  assert.match(app, pattern, `Missing board lifecycle contract: ${name}`);
});

assert.equal((app.match(/window\.addEventListener\("blur", onWindowBlur\)/g) || []).length, 1, "Duplicate blur listener registration");
assert.equal((app.match(/document\.addEventListener\("visibilitychange", onVisibilityChange\)/g) || []).length, 1, "Duplicate visibility listener registration");
assert.match(app, /activeRegistrations\.delete\(registration\)/, "Detached boards must leave the active registration set");

const cacheVersion = "review-v131-board-lifecycle";
const cacheName = "nschess-shell-v131-board-lifecycle";
assert.match(html, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "HTML does not use the v131 asset version");
assert.match(app, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Lazy route loaders do not use the v131 asset version");
assert.match(worker, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker shell assets do not use the v131 asset version");
assert.match(worker, new RegExp(cacheName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker cache name is not v131");
[
  ["index.html", html],
  ["assets/app.js", app],
  ["service-worker.js", worker],
  ["docs/DEPLOYMENT-CHECKLIST.md", deployment]
].forEach(([file, source]) => {
  assert.doesNotMatch(source, /review-v129-interaction-polish|nschess-shell-v129-interaction-polish/, `${file} retains a stale deployment cache identifier`);
});

console.log("board-interaction-regression: lifecycle and cache contracts passed");
