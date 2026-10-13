const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".wasm", "application/wasm"], [".webp", "image/webp"]
]);

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `production function boundary exists: ${name}`);
  return app.slice(start, end).trim();
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    key: (index) => [...values.keys()][index] || null,
    get length() { return values.size; }
  };
}

function testProductionStateLogic() {
  const keys = Object.freeze(["lesson", "puzzle", "botGame"]);
  const localStorage = storage();
  const readJsonStorage = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  const source = [
    functionSource("getDailyPracticeUtcDate", "normalizeDailyPracticeState"),
    functionSource("normalizeDailyPracticeState", "readDailyPracticeState"),
    functionSource("readDailyPracticeState", "writeDailyPracticeState"),
    functionSource("writeDailyPracticeState", "updateDailyPracticeDay"),
    functionSource("updateDailyPracticeDay", "recordDailyPracticeStart"),
    functionSource("recordDailyPracticeStart", "recordDailyPracticeCompletion"),
    functionSource("recordDailyPracticeCompletion", "setDailyPracticeSkipped"),
    functionSource("setDailyPracticeSkipped", "getDailyPracticeReview")
  ].join("\n");
  const create = new Function("dailyPracticeActivityKeys", "dailyPracticeStorageKey", "readJsonStorage", "localStorage", `${source}\nreturn { getDailyPracticeUtcDate, normalizeDailyPracticeState, readDailyPracticeState, recordDailyPracticeStart, recordDailyPracticeCompletion, setDailyPracticeSkipped };`);
  const logic = create(keys, "checkmateQuest.dailyPractice.v1", readJsonStorage, localStorage);
  const currentDate = logic.getDailyPracticeUtcDate();

  assert.equal(logic.getDailyPracticeUtcDate(new Date("2026-10-13T23:30:00-07:00")), "2026-10-14", "practice days use UTC, not the browser's local calendar day");
  const now = new Date("2026-10-13T23:59:00Z");
  const normalized = logic.normalizeDailyPracticeState({ version: 1, days: {
    "2026-09-01": { completed: ["lesson"] },
    "2026-09-30": { completed: ["puzzle"] },
    "2026-10-01": { completed: ["lesson", "review", "lesson"], started: ["review", "bogus"] },
    "2026-10-13": { completed: ["lesson", "lesson", "review"], skipped: ["review", "bad"], reflectionMarked: true },
    "2026-10-14": { completed: ["botGame"] },
    "2026-02-30": { completed: ["puzzle"] }
  } }, now);
  assert.deepEqual(Object.keys(normalized.days), ["2026-09-30", "2026-10-01", "2026-10-13"], "history stays bounded to the last 14 UTC dates and drops future/invalid dates");
  assert.deepEqual(normalized.days["2026-10-01"].completed, ["lesson"], "optional Review reflection cannot count as a core activity completion");
  assert.deepEqual(normalized.days["2026-10-01"].started, ["review"]);

  assert.equal(logic.recordDailyPracticeStart("lesson"), true);
  assert.deepEqual(logic.readDailyPracticeState().days[currentDate].completed, [], "starting a real activity does not mark it complete");
  assert.equal(logic.recordDailyPracticeCompletion("review"), false, "optional reflection cannot enter the 3-step completion count");
  assert.equal(logic.recordDailyPracticeCompletion("lesson"), true);
  assert.equal(logic.recordDailyPracticeCompletion("lesson"), true, "same-day completion is idempotent");
  assert.deepEqual(logic.readDailyPracticeState().days[currentDate].completed, ["lesson"]);
  assert.equal(logic.recordDailyPracticeStart("review"), true, "opening optional Review records only that it was opened");
  assert.deepEqual(logic.readDailyPracticeState().days[currentDate].started, ["lesson", "review"]);
  assert.equal(logic.readDailyPracticeState().days[currentDate].reviewOpened, true);
  assert.equal(logic.setDailyPracticeSkipped("review", true), true, "optional reflection skip is persisted");
  assert.deepEqual(logic.readDailyPracticeState().days[currentDate].skipped, ["review"]);
  assert.equal(logic.setDailyPracticeSkipped("review", false), true, "optional reflection skip can be undone");
  assert.deepEqual(logic.readDailyPracticeState().days[currentDate].skipped, []);
}

function testProductionWorkspaceIsolation() {
  const start = app.indexOf("const accountWorkspaceStorageKey");
  const end = app.indexOf("function reportDeployAssetError", start);
  assert.ok(start >= 0 && end > start, "production account workspace implementation can be isolated for testing");
  const source = app.slice(start, end);
  const localStorage = storage();
  const sessionStorage = storage();
  const key = "checkmateQuest.dailyPractice.v1";
  const guestProgress = JSON.stringify({ version: 1, days: { "2026-10-13": { completed: ["puzzle"] } } });
  localStorage.setItem("checkmateQuest.accountWorkspaceOwner.v1", "guest");
  localStorage.setItem(key, guestProgress);
  const context = { localStorage, sessionStorage, console, Date, Object, String, Boolean, Array };
  vm.runInNewContext(`${source}\nglobalThis.__workspace = { switchAccountWorkspace, accountWorkspaceKeys };`, context, { timeout: 1000 });
  assert.equal(context.__workspace.accountWorkspaceKeys.includes(key), true, "the Phase 11 key is part of the production account-scoped workspace");
  assert.match(fs.readFileSync(path.join(root, "scripts/auth-logout-regression.js"), "utf8"), /"checkmateQuest\.dailyPractice\.v1"/);
  const e2e = fs.readFileSync(path.join(root, "scripts/e2e-runner.cjs"), "utf8");
  assert.ok((e2e.match(/"checkmateQuest\.dailyPractice\.v1"/g) || []).length >= 2, "guest account-boundary diagnostics enumerate Daily Practice state");
  context.__workspace.switchAccountWorkspace({ authUserId: "account-a" });
  assert.equal(localStorage.getItem(key), null, "A starts without guest-local progress");
  localStorage.setItem(key, JSON.stringify({ account: "A" }));
  context.__workspace.switchAccountWorkspace({ authUserId: "account-b" });
  assert.equal(localStorage.getItem(key), null, "B cannot see A's routine marks");
  localStorage.setItem(key, JSON.stringify({ account: "B" }));
  context.__workspace.switchAccountWorkspace({ authUserId: "account-a" });
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), { account: "A" }, "returning to A restores only A's saved workspace");
  context.__workspace.switchAccountWorkspace({ publicId: "guest" });
  assert.equal(localStorage.getItem(key), guestProgress, "guest-local practice remains device-local and isolated from authenticated accounts");
}

function assertCompletionBoundaries() {
  const lesson = functionSource("completeTutorialQuiz", "renderTutorialQuiz");
  const puzzle = functionSource("completeRealPuzzle", "handleRealPuzzleSquare");
  const gameStart = app.indexOf("function recordCompletedGame(record)");
  const gameEnd = app.indexOf("function ", gameStart + 1);
  const game = app.slice(gameStart, gameEnd);
  assert.match(lesson, /recordDailyPracticeCompletion\("lesson"\)/, "lesson marks are written from the completed quiz path");
  assert.match(lesson, /publishLearningActivity\("lesson_completed"[\s\S]*?recordDailyPracticeCompletion\("lesson"\)/, "lesson activity is recorded only after canonical local lesson completion processing");
  assert.match(puzzle, /if \(realPuzzleMode === "Trainer"\) recordDailyPracticeCompletion\("puzzle"\)/, "only a completed Trainer puzzle marks the routine, not Rush/Streak/Battle or opening the page");
  assert.match(game, /record\?\.mode[\s\S]*?=== "ai game"[\s\S]*?next\.result !== "aborted"[\s\S]*?next\.moves > 0[\s\S]*?recordDailyPracticeCompletion\("botGame"\)/, "only a non-aborted AI game with played moves marks completion");
  assert.doesNotMatch(app.slice(app.indexOf("function handleDailyPracticeClick"), app.indexOf("function resetDailyPracticeMarks")), /recordDailyPracticeCompletion/, "navigation, skip, and optional Review actions never mark a core task complete");
  assert.match(app, /"checkmateQuest\.dailyPractice\.v1"[\s\S]*?function normalizeDailyPracticeState/, "daily state has its own versioned storage key");
  assert.doesNotMatch(app.slice(app.indexOf("function renderDailyPracticeHub"), app.indexOf("function handleDailyPracticeClick")), /supabase|settle_player_progression|publishLearningActivity/, "rendering the routine does not claim server completion or reward");
  assert.doesNotMatch(lesson + puzzle + game, /settle_player_progression|award.*daily|daily.*xp/i, "the routine hooks do not grant a new daily reward");
}

function startServer() {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
    catch { response.writeHead(400).end(); return; }
    if (pathname === "/") pathname = "/index.html";
    const target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    fs.stat(target, (statError, stat) => {
      const file = !statError && stat.isDirectory() ? path.join(target, "index.html") : target;
      fs.readFile(file, (error, content) => {
        if (error) { response.writeHead(404).end("Not found"); return; }
        response.writeHead(200, { "Content-Type": mime.get(path.extname(file)) || "application/octet-stream", "Cache-Control": "no-store" });
        response.end(content);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server); });
  });
}

function expectedMove(text) {
  const match = String(text).match(/Step\s+\d+\s+of\s+\d+:\s*(?:select\s+)?([a-h][1-8])(?:,\s*then play|\s+to)\s*([a-h][1-8])/i);
  return match ? { from: match[1], to: match[2] } : null;
}

async function exerciseBrowser() {
  assert.ok(fs.existsSync(chromePath), `Existing Chrome is available at ${chromePath}`);
  const { chromium } = require("playwright");
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromePath, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const blockedOrigins = new Set();
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      blockedOrigins.add(new URL(url).origin);
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/#plan`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll("#dailyPracticeTasks .daily-practice-task").length === 3
      && document.querySelector("#plan")?.classList.contains("is-active-panel"), null, { timeout: 30000 });

    assert.equal(await page.locator("#dailyPracticeCount").innerText(), "0 / 3");
    assert.match(await page.locator("#dailyPracticeStatus").innerText(), /only|device|reward/i);
    assert.equal(await page.locator("#dailyTrainingForm").count(), 0, "the old aspirational builder is not an active competing form");
    assert.equal(await page.locator("#plan template.legacy-study-plan").evaluate((template) => template.content.querySelectorAll("[id], a, button, input").length > 0), true, "retired roadmap controls remain inert inside a template, not active DOM");
    assert.equal(await page.locator("#plan #dailyTrainingForm").count(), 0, "no retired form control is addressable in the active DOM");
    assert.equal(await page.locator("#dailyPracticeTasks .daily-practice-start").count(), 3);

    await page.locator('[data-daily-practice-skip="puzzle"]').click();
    assert.equal(await page.locator("#dailyPracticeCount").innerText(), "0 / 3", "skipping does not fabricate completion");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.dailyPractice.v1")).days[new Date().toISOString().slice(0, 10)].completed), []);
    await page.locator('[data-daily-practice-unskip="puzzle"]').click();
    await page.locator('[data-daily-practice-start="lesson"]').click();
    await page.waitForFunction(() => location.hash === "#tutorial" && document.querySelectorAll("#tutorialBoard [data-square]").length === 64, null, { timeout: 15000 });
    for (let guard = 0; guard < 16; guard += 1) {
      const prompt = await page.locator("#tutorialCoach").innerText();
      const move = expectedMove(prompt);
      if (!move) break;
      await page.locator(`#tutorialBoard [data-square="${move.from}"]`).click();
      await page.locator(`#tutorialBoard [data-square="${move.to}"]`).click();
    }
    assert.equal(await page.locator("#tutorialQuiz button").count(), 3, "the actual guided lesson reaches its knowledge check only after board moves");
    await page.locator("#tutorialQuiz button").nth(0).click();
    await page.waitForFunction(() => {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.dailyPractice.v1") || "{}");
      return state.days?.[new Date().toISOString().slice(0, 10)]?.completed?.includes("lesson");
    }, null, { timeout: 5000 });
    assert.equal(await page.locator("#dailyPracticeHub").isVisible(), false, "Daily Practice is not visible on unrelated routes");
    await page.evaluate(() => { location.hash = "#plan"; });
    await page.waitForFunction(() => location.hash === "#plan");
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "1 / 3");
    assert.equal(await page.locator('#dailyPracticeTasks [data-daily-practice-start="lesson"]').count(), 0, "a completed step has no action that could replay it as unfinished");
    assert.match(await page.locator("#dailyPracticeTasks").innerText(), /Completed today/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.hash === "#plan" && document.getElementById("dailyPracticeCount")?.textContent === "1 / 3", null, { timeout: 15000 });
    await page.locator('[data-daily-practice-start="puzzle"]').click();
    await page.waitForFunction(() => location.hash === "#puzzles" && document.getElementById("realPuzzleBoard")?.children.length === 64, null, { timeout: 20000 });
    assert.equal(await page.locator('[data-real-mode="Trainer"][aria-pressed="true"]').count(), 1, "the puzzle action opens the existing Trainer mode");
    await page.evaluate(() => { location.hash = "#plan"; });
    await page.waitForFunction(() => location.hash === "#plan");
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "1 / 3");
    await page.locator('[data-daily-practice-start="botGame"]').click();
    await page.waitForFunction(() => location.hash === "#bots" && document.querySelectorAll("#aiBotRoster .ai-bot-card").length > 0, null, { timeout: 15000 });
    assert.equal(await page.locator("#bots").isVisible(), true, "the bot action opens the existing AI bot roster");
    await page.evaluate(() => { location.hash = "#plan"; });
    await page.waitForFunction(() => location.hash === "#plan");
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "1 / 3");

    // Complete the remaining steps through real legal moves and game controls.
    // Opening a task above was explicitly verified to leave the count at 1/3.
    await page.locator('[data-daily-practice-start="puzzle"]').click();
    await page.waitForFunction(() => window.checkmatePuzzleRuntime?.event === "puzzle-loaded");
    const puzzleId = await page.evaluate(() => window.checkmatePuzzleRuntime.puzzleId);
    const payload = JSON.parse(fs.readFileSync(path.join(root, "data/puzzles.json"), "utf8"));
    const puzzle = (Array.isArray(payload) ? payload : payload.puzzles).find((item) => item.id === puzzleId || item.PuzzleId === puzzleId);
    assert.ok(puzzle, "Trainer position belongs to the shipped catalog");
    const { Chess } = await import(pathToFileURL(path.join(root, "assets/vendor/chess.js-1.0.0.mjs")));
    const chess = new Chess(puzzle.fen || puzzle.FEN);
    const line = [...(puzzle.moves || puzzle.Moves.split(/\s+/))];
    if (puzzle.primer) {
      const uci = line.shift();
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
    }
    const player = chess.turn();
    for (const uci of line) {
      const turn = chess.turn();
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
      if (turn !== player) continue;
      await page.locator(`#realPuzzleBoard [data-square="${uci.slice(0, 2)}"]`).click();
      await page.locator(`#realPuzzleBoard [data-square="${uci.slice(2, 4)}"]`).click();
      if (uci[4]) await page.locator(`.promotion-picker [data-promotion="${uci[4]}"]`).click();
      await page.waitForFunction(() => ["PlayerTurn", "Completed"].includes(document.getElementById("realPuzzles")?.dataset.puzzlePhase));
    }
    await page.waitForFunction(() => document.getElementById("realPuzzles")?.dataset.puzzlePhase === "Completed");
    await page.evaluate(() => { location.hash = "#plan"; });
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "2 / 3");
    await page.locator('[data-daily-practice-start="botGame"]').click();
    await page.locator("#aiBotRoster [data-ai-bot-play]").first().click();
    await page.locator("#aiGameReady").waitFor({ state: "visible" });
    await page.locator('#aiGameReady [data-ai-game-ready-pace="none"]').click();
    await page.locator("#aiGameReadyStart").click();
    await page.waitForFunction(() => document.getElementById("play")?.classList.contains("is-active-game"));
    await page.locator('#coachBoard [data-square="e2"]').click();
    await page.locator('#coachBoard [data-square="e4"]').click();
    await page.waitForFunction(() => document.getElementById("moveHistory")?.textContent.includes("e4"));
    await page.locator("#resignGame").click();
    await page.locator("#resignConfirmButton").click();
    await page.evaluate(() => { location.hash = "#plan"; });
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "3 / 3");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "3 / 3");
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("dailyPracticeCount")?.textContent === "3 / 3");
    assert.match(await page.locator('meta[name="robots"]').getAttribute("content"), /noindex/, "offline Daily Practice retains private workspace metadata");

    const layouts = [];
    for (const width of [1366, 768, 430, 390, 375, 360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const root = document.getElementById("plan");
        const hub = document.getElementById("dailyPracticeHub");
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          hubWidth: Math.round(hub.getBoundingClientRect().width),
          columns: getComputedStyle(document.getElementById("dailyPracticeTasks")).gridTemplateColumns,
          controls: [...hub.querySelectorAll("button:not([disabled])")].map((button) => ({
            label: button.innerText.trim(), height: Math.round(button.getBoundingClientRect().height), visible: button.getBoundingClientRect().width > 0
          })),
          role: document.getElementById("dailyPracticeStatus").getAttribute("role"),
          statusLive: document.getElementById("dailyPracticeStatus").getAttribute("aria-live"),
          routeVisible: getComputedStyle(root).display !== "none"
        };
      });
      assert.ok(layout.scrollWidth <= width + 1, `Daily Practice has no horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.routeVisible, true);
      assert.equal(layout.role, "status");
      assert.equal(layout.statusLive, "polite");
      assert.ok(layout.controls.every((button) => button.visible && button.height >= 44), `interactive controls remain visible and at least 44px at ${width}px`);
      if (width <= 820) assert.equal(layout.columns.split(" ").length, 1, `task cards stack on mobile at ${width}px`);
      layouts.push(layout);
    }
    if (process.env.PHASE11_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PHASE11_SCREENSHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.screenshot({ path: path.join(process.env.PHASE11_SCREENSHOT_DIR, "phase11-after-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      await page.screenshot({ path: path.join(process.env.PHASE11_SCREENSHOT_DIR, "phase11-after-320.png"), fullPage: true });
    }
    await page.locator("#dailyPracticeReset").click();
    assert.equal(await page.locator("#dailyPracticeCount").innerText(), "0 / 3", "reset clears only today's routine marks");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.beginnerTutorial.v1") || "{}").completed.includes("setup")), true, "reset preserves the underlying completed lesson");
    assert.deepEqual(errors, [], `no uncaught browser errors: ${errors.join("; ")}`);
    await context.close();
    return { browser: await browser.version(), completedActivities: ["lesson board line + knowledge check", "legal Trainer solution", "played AI game finished through resignation"], localCount: "3 / 3", offlinePersistence: true, layouts, externalOriginsBlocked: [...blockedOrigins], pageErrors: errors };
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const start = performance.now();
  assert.match(html, /id="dailyPracticeHub"[\s\S]*?id="dailyPracticeCount"[\s\S]*?id="dailyPracticeStatus"[^>]*role="status"/);
  const activeHtml = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");
  assert.match(html, /assets\/app\.js\?v=daily-practice-v1/);
  assert.match(serviceWorker, /nschess-shell-v199-daily-practice-seo[\s\S]*?assets\/app\.js\?v=daily-practice-v1/, "the offline shell cache is renewed for this app version");
  assert.match(html, /<template class="legacy-study-plan">[\s\S]*?id="dailyTrainingForm"[\s\S]*?<\/template>/, "legacy plan content remains inert template material only");
  assert.doesNotMatch(activeHtml, /id="dailyTrainingForm"/, "the discontinued manual completion form is not active HTML");
  assertCompletionBoundaries();
  testProductionStateLogic();
  testProductionWorkspaceIsolation();
  const browser = await exerciseBrowser();
  process.stdout.write(`${JSON.stringify({ result: "PASS", productionLogic: "PASS", accountWorkspaceIsolation: "PASS", browser }, null, 2)}\n`);
  process.stdout.write(`daily-practice-regression: passed in ${Math.round(performance.now() - start)}ms\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL Daily Practice regression: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
