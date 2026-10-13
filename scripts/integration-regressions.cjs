"use strict";
// Explicit offline suites only. No authenticated runner, migration, provisioner
// or deployment command is reachable through this integration entry point.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const groups = {
  core: ["verify-site.js", "route-interaction-regression.js", "board-interaction-regression.js", "board-drag-follow-regression.js", "board-drag-size-regression.js", "accessibility-regression.js", "learn-regression.cjs", "game-review-regression.js", "auth-logout-regression.js", "oauth-auth-regression.js", "multiplayer-regression.js", "matchmaking-regression.js", "e2e-safety-regression.cjs", "profile-progress-regression.js", "promotion-regression.js", "daily-puzzle-regression.cjs", "master-runtime-regression.cjs"],
  daily: ["daily-practice-regression.cjs", "learn-browser-regression.cjs", "puzzle-modes-browser-e2e.cjs", "daily-puzzle-browser-e2e.cjs", "pwa-regression.cjs"],
  boards: ["play-board-priority-regression.js", "board-sizing-regression.js", "play-gameplay-regression.cjs", "ai-bot-regression.cjs"],
  seo: ["seo-regression.cjs"],
  routing: ["integration-routing-regression.cjs"],
  performance: ["master-browser-regression.cjs"]
};
const group = process.argv[2];
if (!groups[group]) throw new Error("Choose core, daily, boards, seo, routing or performance.");
const resumeAt = process.argv[3];
const startIndex = resumeAt ? groups[group].indexOf(resumeAt) : 0;
if (startIndex < 0) throw new Error("Resume script must belong to the chosen offline group.");
const output = path.join(root, "e2e-artifacts/integration", group);
fs.mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/SUPABASE|^E2E_/i.test(key)));
if (group === "performance") Object.assign(env, { MASTER_MEASURE: "1", MASTER_COMPARE_SHA: "12b9e9d93d94be5af9e643c0bec9a3234c0a27c0", MASTER_LABEL: "phase11-12-integration" });
if (group === "daily") env.PHASE11_SCREENSHOT_DIR = path.join(output, "screenshots");
const reportFile = path.join(output, "report.json");
const report = resumeAt && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")).slice(0, startIndex) : [];
for (const script of groups[group].slice(startIndex)) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script)], { cwd: root, env, encoding: "utf8", maxBuffer: 40 * 1024 * 1024, timeout: 900000 });
  fs.writeFileSync(path.join(output, script + ".log"), (result.stdout || "") + (result.stderr || ""));
  const row = { script, result: result.status === 0 ? "PASS" : "FAIL", milliseconds: Date.now() - start, exitCode: result.status, error: result.error?.message };
  report.push(row);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${row.result} ${script} (${Math.round(row.milliseconds / 1000)}s)`);
  if (row.result !== "PASS") {
    console.error(((result.stderr || result.stdout || "") + (result.error?.message || "")).slice(-2500));
    process.exitCode = 1;
    break;
  }
}
