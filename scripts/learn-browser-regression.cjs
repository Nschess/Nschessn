const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".wasm", "application/wasm"], [".webp", "image/webp"]
]);

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

function parseExpectedMove(text) {
  const match = String(text).match(/Step\s+(\d+)\s+of\s+(\d+):\s*(?:select\s+)?([a-h][1-8])(?:,\s*then play|\s+to)\s*([a-h][1-8])/i);
  return match ? { number: Number(match[1]), total: Number(match[2]), from: match[3], to: match[4] } : null;
}

async function completeLineInBrowser(page, index) {
  const started = performance.now();
  const lessonButton = page.locator("#tutorialLessonList [data-tutorial-lesson-index]").nth(index);
  const lessonName = (await lessonButton.innerText()).replace(/\s*· Done$/, "");
  await lessonButton.evaluate((button) => button.click());
  let moves = 0;
  for (let guard = 0; guard < 16; guard += 1) {
    const coach = await page.locator("#tutorialCoach").innerText();
    if (/lesson paused|restart this lesson/i.test(coach)) throw new Error(`${lessonName}: ${coach}`);
    const expected = parseExpectedMove(coach);
    if (!expected) break;
    if (expected.number !== moves + 1 || expected.total < expected.number) {
      throw new Error(`${lessonName}: unexpected move sequence: ${coach}`);
    }
    const source = page.locator(`#tutorialBoard [data-square="${expected.from}"]`);
    await source.evaluate((button, to) => {
      button.click();
      document.querySelector(`#tutorialBoard [data-square="${to}"]`)?.click();
    }, expected.to);
    moves += 1;
  }
  const coach = await page.locator("#tutorialCoach").innerText();
  if (/lesson paused|restart this lesson/i.test(coach)) throw new Error(`${lessonName}: ${coach}`);
  const quizButtons = await page.locator("#tutorialQuiz button").count();
  assert.equal(quizButtons, 3, `${lessonName}: the real board task reaches its three-choice quiz`);
  return { lesson: lessonName, moves, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
}

async function completeVisibleRemainder(page) {
  for (let guard = 0; guard < 16; guard += 1) {
    const coach = await page.locator("#tutorialCoach").innerText();
    if (/lesson paused|restart this lesson/i.test(coach)) throw new Error(coach);
    const expected = parseExpectedMove(coach);
    if (!expected) return;
    await page.locator(`#tutorialBoard [data-square="${expected.from}"]`).click();
    await page.locator(`#tutorialBoard [data-square="${expected.to}"]`).click();
  }
  throw new Error("The active lesson did not reach its quiz after the bounded move count.");
}

async function measureLayout(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(() => {
    const board = document.querySelector("#tutorialBoard");
    const wrap = board?.closest(".tutorial-board-wrap");
    if (!board || !wrap) return false;
    const boardWidth = board.getBoundingClientRect().width;
    return boardWidth > 0 && boardWidth <= wrap.clientWidth + 1 && boardWidth <= innerWidth + 1;
  }, null, { timeout: 3000 });
  return page.evaluate(() => {
    const section = document.querySelector("#tutorial");
    const board = document.querySelector("#tutorialBoard");
    const box = board.getBoundingClientRect();
    const buttons = ["tutorialHint", "tutorialReplay", "tutorialNext"].map((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { id, width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      sectionWidth: section.clientWidth,
      boardWidth: Math.round(box.width),
      boardHeight: Math.round(box.height),
      buttons
    };
  });
}

async function main() {
  assert.ok(fs.existsSync(chromePath), `Existing Chrome is available at ${chromePath}`);
  const { chromium } = require("playwright");
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromePath, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    const blockedOrigins = new Set();
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      blockedOrigins.add(new URL(url).origin);
      return route.abort();
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__learnListenerCounts = { listClick: 0, rowClick: 0 };
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type === "click" && this instanceof Element) {
          if (this.id === "tutorialLessonList") window.__learnListenerCounts.listClick += 1;
          if (this.matches("[data-tutorial-lesson-index]")) window.__learnListenerCounts.rowClick += 1;
        }
        return Reflect.apply(add, this, [type, listener, options]);
      };
    });

    const loadStarted = performance.now();
    await page.goto(`${origin}/#tutorial`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll("#tutorialBoard [data-square]").length === 64
      && document.querySelectorAll("#tutorialLessonList [data-tutorial-lesson-index]").length === 68
      && !/Chess rules are still loading/i.test(document.querySelector("#tutorialCoach")?.textContent || ""), null, { timeout: 30000 });
    const initialLoadMs = Math.round((performance.now() - loadStarted) * 10) / 10;

    assert.equal(await page.locator("#tutorial").isVisible(), true, "the Learn route opens the guided lesson interface");
    assert.equal(await page.locator('#tutorialBoard[aria-roledescription="chess board"]').count(), 1);
    assert.equal(await page.locator("#tutorialTopicFilter").getAttribute("aria-label"), "Filter guided lessons by topic");

    // Prove wrong/legal, illegal, hint, keyboard and completion behavior on the first real lesson.
    await page.locator("#tutorialHint").click();
    assert.match(await page.locator("#tutorialCoach").innerText(), /^Hint:/);
    await page.locator('#tutorialBoard [data-square="e2"]').focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('#tutorialBoard [data-square="e2"]').getAttribute("aria-label").then((label) => /selected/.test(label)), true, "keyboard activates the lesson source square");
    await page.locator('#tutorialBoard [data-square="e5"]').click();
    assert.match(await page.locator("#tutorialCoach").innerText(), /not legal/i, "an illegal chess move is rejected with feedback");
    await page.locator('#tutorialBoard [data-square="e3"]').click();
    assert.match(await page.locator("#tutorialCoach").innerText(), /legal, but this step wants/i, "a legal but incorrect move receives retry guidance");
    await page.locator('#tutorialBoard [data-square="e4"]').click();
    await completeVisibleRemainder(page);
    assert.equal(await page.locator("#tutorialQuiz button").count(), 3, "the correct board line advances to the knowledge check");
    await page.locator("#tutorialQuiz button").nth(1).click();
    assert.match(await page.locator("#tutorialCoach").innerText(), /stronger idea/i, "a wrong quiz answer can be retried");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("checkmateQuest.beginnerTutorial.v1")).completed.includes("setup")), false, "wrong quiz answers do not complete a lesson");
    await page.locator("#tutorialQuiz button").nth(0).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("checkmateQuest.beginnerTutorial.v1") || "{}").completed?.includes("setup"));
    assert.match(await page.locator("#tutorialProgressText").innerText(), /^1\/68 complete/);
    await page.locator("#tutorialReplay").click();
    assert.equal(await page.locator("#tutorialQuiz button").count(), 0, "replay resets the board task without erasing its completed mark");
    assert.match(await page.locator("#tutorialQuiz").innerText(), /Guided move 1\//);
    assert.match(await page.locator("#tutorialProgressText").innerText(), /^1\/68 complete/);

    const lineEvidence = [];
    for (let index = 0; index < 68; index += 1) lineEvidence.push(await completeLineInBrowser(page, index));
    assert.equal(lineEvidence.length, 68, "the browser executes all 68 lesson board tasks to their quiz boundary");
    assert.ok(lineEvidence.every((entry) => entry.moves >= 1), "every lesson requires at least one genuine board move");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#tutorialBoard [data-square]").length === 64
      && document.querySelectorAll("#tutorialLessonList [data-tutorial-lesson-index]").length === 68, null, { timeout: 15000 });
    assert.match(await page.locator("#tutorialProgressText").innerText(), /^1\/68 complete/, "device-local completion survives a reload");
    assert.equal(await page.locator('#tutorialLessonList [data-tutorial-lesson-index="0"]').evaluate((button) => button.classList.contains("is-complete")), true);

    await page.locator("#tutorialTopicFilter").selectOption("Tactics");
    const tacticCount = await page.locator("#tutorialLessonList [data-tutorial-lesson-index]").count();
    assert.ok(tacticCount > 0 && tacticCount < 68, "topic filtering narrows the real course list");
    assert.match(await page.locator("#tutorialProgressText").innerText(), /Tactics \d+\/\d+/);
    await page.locator("#tutorialTopicFilter").selectOption("all");
    await page.locator('#tutorialLessonList [data-tutorial-lesson-index="0"]').evaluate((button) => button.click());
    await page.locator("#tutorialNext").click();
    assert.equal(await page.locator('#tutorialLessonList [data-tutorial-lesson-index="1"]').getAttribute("aria-current"), "step", "Next lesson opens the following supported lesson");
    const renderEvidence = await page.evaluate(() => {
      const list = document.getElementById("tutorialLessonList");
      const samples = [];
      for (const index of [1, 67, 3, 65, 5, 63, 7, 61, 9, 59]) {
        const button = list.querySelector(`[data-tutorial-lesson-index="${index}"]`);
        const started = performance.now();
        button.click();
        samples.push(Math.round((performance.now() - started) * 100) / 100);
      }
      return { samples, listeners: window.__learnListenerCounts };
    });
    assert.equal(renderEvidence.listeners.listClick, 1, "the lesson list registers one delegated click listener");
    assert.equal(renderEvidence.listeners.rowClick, 0, "rendered lesson rows do not accumulate individual handlers");

    const layouts = [];
    for (const width of [1366, 768, 430, 390, 375, 360, 320]) {
      const layout = await measureLayout(page, width);
      assert.ok(layout.documentWidth <= width + 1, `the Learn page has no horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.boardWidth > 0 && layout.boardWidth <= width && layout.boardWidth === layout.boardHeight, `the lesson board remains square and within ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.buttons.every((button) => button.height >= 44), `primary lesson controls meet 44px target at ${width}px: ${JSON.stringify(layout.buttons)}`);
      layouts.push(layout);
    }

    await page.evaluate(() => { location.hash = "#paths"; });
    await page.waitForFunction(() => location.hash === "#paths");
    const roadmapCopy = await page.locator("#paths .section-intro").innerText();
    assert.match(roadmapCopy, /not interactive courses yet/i);
    await page.locator('#paths a[href="#tutorial"]').click();
    await page.waitForFunction(() => location.hash === "#tutorial");
    await page.waitForFunction(() => document.querySelectorAll("#tutorialBoard [data-square]").length === 64);
    assert.equal(await page.locator("#tutorialLessonList [aria-current=step]").count(), 1, "lesson selection remains correctly exposed after route return");
    assert.deepEqual(pageErrors, [], `the browser reports no uncaught Learn errors: ${pageErrors.join("; ")}`);

    const result = {
      result: "PASS",
      browser: await browser.version(),
      route: "#tutorial → #paths → #tutorial",
      authoredLessonsExercised: lineEvidence.length,
      wrongAndIllegalMoveFeedback: "PASS",
      hintAndKeyboard: "PASS",
      retryAndLocalCompletion: "PASS",
      topicFilter: { selected: "Tactics", visible: tacticCount },
      layout: layouts,
      initialLocalLoadMs: initialLoadMs,
      lessonRenderSyncMedianMs: [...renderEvidence.samples].sort((a, b) => a - b)[Math.floor(renderEvidence.samples.length / 2)],
      lessonRowListenersAfterRepeatedNavigation: renderEvidence.listeners.rowClick,
      lessonListDelegatedListeners: renderEvidence.listeners.listClick,
      externalOriginsBlockedForIsolation: [...blockedOrigins],
      uncaughtPageErrors: pageErrors.length
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL Learn browser regression: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
