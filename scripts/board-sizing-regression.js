/*
 * Regression coverage for the board-sizing path that actually ships.
 *
 * The shared workspace is intentionally tested through real board geometry,
 * controls, resize state, and Play/Puzzle input. Settings-driven scaling
 * remains a supported preference, but it must feed the same global controller.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.E2E_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function staticContract() {
  const app = read("assets/app.js");
  const css = read("assets/app.css");
  const html = read("index.html");
  const serviceWorker = read("service-worker.js");

  assert.match(app, /const chessJsUrl\s*=\s*["']\.\/vendor\/chess\.js-1\.0\.0\.mjs["']/,
    "Chess rules must use the tracked local vendor module.");
  assert.doesNotMatch(app, /https:\/\/cdn\.jsdelivr\.net\/npm\/chess\.js@1\.0\.0/,
    "The application must not retain the external chess.js runtime import.");
  assert.match(app, /async function loadChessRules\(\)[\s\S]*?import\(chessJsUrl\)/,
    "The shared chess rules loader must remain the single import path.");

  assert.match(app, /function applyPlayBoardScale\(prefs\)/,
    "The shared board preference adapter is missing.");
  assert.match(app, /const boardSizeMap = \{ small: 560, medium: 640, large: 720, xl: 840 \}/,
    "Play board size presets must remain explicit.");
  assert.match(app, /playSection\?\.style\.setProperty\("--user-board-size", `\$\{scaledBoardSize\}px`\)/,
    "Play must receive the resolved board size through its shared CSS variable.");
  assert.match(app, /prefs\.boardScale = clampNumber\(Number\(prefs\.boardScale\) \|\| 100, 82, 122\)/,
    "Board scale preferences must remain bounded.");
  assert.match(app, /prefKey === "boardScale"[\s\S]*?applySettingsPrefsPatch\(\{ boardScale: field\.value \}/,
    "The settings board scale control must continue to update persisted preferences.");

  assert.match(css, /--user-board-size/);
  assert.match(css, /#play[^\n]*\.play-board-wrap|#play[\s\S]*?\.play-board-wrap/,
    "Play board layout must consume the board sizing styles.");
  ["#coachBoard", "#realPuzzleBoard", "#tutorialBoard", "#adventureBoard", "#openingExplorerBoard"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id.slice(1)}"`), `Missing shared board host ${id}.`);
  });
  assert.match(app, /boardInteractionEngine\.attach\(board/,
    "Board surfaces must continue using the shared interaction engine.");
  assert.match(app, /const interactiveBoardSizeStorageKey = "checkmateQuest\.boardSizing\.v1"/,
    "The shared board sizing controller must have a stable persistence key.");
  assert.match(app, /data-interactive-board-stage|\[data-interactive-board-stage\]/,
    "The shared board stage contract is missing.");
  assert.match(app, /data-board-resize-handle/,
    "The shared direct resize handle contract is missing.");
  assert.match(app, /requestFullscreen\?\.\(\{ navigationUI: "hide" \}\)/,
    "The shared board fullscreen host must use native fullscreen.");
  assert.match(css, /\.interactive-board-sizing-stage/,
    "The shared board sizing stage styles are missing.");
  assert.match(css, /\.interactive-board-fullscreen-host:fullscreen/,
    "The shared board fullscreen geometry styles are missing.");
  assert.match(html, /data-interactive-board-stage/,
    "Interactive board stages must be wired in the shipped markup.");
  assert.match(serviceWorker, /\.\/assets\/vendor\/chess\.js-1\.0\.0\.mjs/,
    "The local chess runtime must be part of the offline app shell.");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => {
      if (Date.now() - started > 15000) {
        reject(new Error("Board sizing test server did not start."));
        return;
      }
      setTimeout(check, 50);
    };
    const check = () => {
      const request = http.get(`${baseUrl}/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    check();
  });
}

async function waitForBoard(page, selector) {
  await page.waitForFunction((target) => {
    const board = document.querySelector(target);
    const piece = board?.querySelector(".piece-svg, .piece-symbol, img");
    const rect = board?.getBoundingClientRect();
    const stageRect = board?.closest("[data-interactive-board-stage]")?.getBoundingClientRect();
    return board?.querySelectorAll("[data-square]").length === 64
      && piece
      && rect?.width >= 100
      && rect?.height >= 100
      && stageRect?.width >= rect.width - 1;
  }, selector, { timeout: 15000 });
  const state = await readBoardState(page, selector);
  assert.equal(state.squares, 64, `${selector}: expected 64 board squares.`);
  assert(state.pieces > 0 && state.visiblePieces === state.pieces,
    `${selector}: expected visible rendered pieces: ${JSON.stringify(state)}.`);
  assert(Math.abs(state.boardWidth - state.boardHeight) < 1,
    `${selector}: board must remain square: ${JSON.stringify(state)}.`);
  assert(Math.abs(state.squareWidth - state.squareHeight) < 0.1,
    `${selector}: board squares must remain square: ${JSON.stringify(state)}.`);
  assert(state.boardWidth <= state.stageWidth + 1,
    `${selector}: board exceeded its shared stage width: ${JSON.stringify(state)}.`);
  if (state.frameWidths.length) {
    assert(state.frameWidths.every((width) => width <= state.boardWidth + 1),
      `${selector}: player frame exceeded the current board width: ${JSON.stringify(state)}.`);
  }
  assert.equal(state.pageOverflow, false, `${selector}: board layout introduced page overflow.`);
  assert.equal(state.stageControls, true, `${selector}: shared board controls did not mount.`);
  assert.equal(state.resizeHandle, true, `${selector}: shared resize handle did not mount.`);
}

async function readBoardState(page, selector) {
  return page.evaluate((target) => {
    const board = document.querySelector(target);
    const wrap = board?.parentElement;
    const sizingScope = board?.closest("#play");
    const squares = [...(board?.querySelectorAll("[data-square]") || [])];
    const pieces = [...(board?.querySelectorAll(".piece-svg, .piece-symbol, img") || [])];
    const boardRect = board?.getBoundingClientRect();
    const squareRect = squares[0]?.getBoundingClientRect();
    return {
      squares: squares.length,
      pieces: pieces.length,
      visiblePieces: pieces.filter((piece) => {
        const rect = piece.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length,
      boardWidth: boardRect?.width || 0,
      boardHeight: boardRect?.height || 0,
      squareWidth: squareRect?.width || 0,
      squareHeight: squareRect?.height || 0,
      boardSizeVariable: getComputedStyle(sizingScope || document.documentElement).getPropertyValue("--user-board-size").trim(),
      disabledSquares: squares.filter((square) => square.disabled).length,
      pointerEvents: squareRect ? getComputedStyle(squares[0]).pointerEvents : "",
      stageWidth: board?.closest("[data-interactive-board-stage]")?.getBoundingClientRect().width || 0,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      frameWidths: [...(board?.closest(".match-board-column")?.querySelectorAll(".ai-player-card, .match-player-card") || [])]
        .map((frame) => frame.getBoundingClientRect().width),
      stageControls: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-stage-tools]")),
      resizeHandle: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-resize-handle]"))
    };
  }, selector);
}

async function openRoute(page, hash) {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((target) => document.querySelector(target)?.classList.contains("is-active-panel"), hash.split("?")[0].replace("#", "#"));
}

async function waitForRouteStylesheet(page, name) {
  await page.waitForFunction((styleName) => {
    const link = document.querySelector(`link[data-route-style="${styleName}"]`);
    return Boolean(link?.sheet);
  }, name, { timeout: 15000 });
}

async function setBoardScale(page, value) {
  await openRoute(page, "#settings");
  await page.locator('[data-settings-tab="gameplay"]').click();
  const slider = page.locator('input[data-pref-setting="boardScale"]');
  await slider.waitFor({ state: "visible" });
  await slider.evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await page.waitForFunction((expected) => {
    try {
      return Number(JSON.parse(localStorage.getItem("checkmateQuest.preferences.v1") || "{}").boardScale) === expected;
    } catch {
      return false;
    }
  }, value);
}

async function startPlayGame(page) {
  await openRoute(page, "#bots");
  const bot = page.locator("#aiBotRoster [data-ai-bot-play]").first();
  await bot.waitFor({ state: "visible" });
  await bot.click();
  const ready = page.locator("#aiGameReady");
  await ready.waitFor({ state: "visible" });
  await page.locator("#aiGameReadyStart").click();
  await waitForBoard(page, "#coachBoard");
}

async function waitForBoardWidthBelow(page, previousWidth) {
  await page.waitForFunction((previous) => {
    const board = document.querySelector("#coachBoard");
    const rect = board?.getBoundingClientRect();
    return Boolean(rect?.width) && rect.width < previous - 20;
  }, previousWidth, { timeout: 5000 });
}

async function verifyPointerResizeAndFullscreen(page, selector) {
  const board = page.locator(selector);
  const stage = board.locator("xpath=..");
  const flip = stage.locator('[data-board-action="flip"]');
  await flip.click();
  await page.waitForFunction((target) => document.querySelector(target)?.dataset.boardOrientation === "flipped", selector, { timeout: 5000 });
  assert.equal(await flip.getAttribute("aria-pressed"), "true", `${selector}: Flip Board did not expose its active state.`);
  await flip.click();
  await page.waitForFunction((target) => document.querySelector(target)?.dataset.boardOrientation === "normal", selector, { timeout: 5000 });
  assert.equal(await flip.getAttribute("aria-pressed"), "false", `${selector}: Flip Board did not restore its inactive state.`);
  const handle = stage.locator("[data-board-resize-handle]");
  await handle.scrollIntoViewIfNeeded();
  const before = await stage.evaluate((element) => ({
    requested: Number(element.dataset.boardRequestedSize || 0),
    rendered: Number(element.dataset.boardRenderedSize || 0),
    manual: element.dataset.boardManualSize
  }));
  const handleBox = await handle.boundingBox();
  assert(handleBox, `${selector}: direct resize handle was not measurable.`);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 72, handleBox.y + handleBox.height / 2 + 72, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction((target) => {
    const element = document.querySelector(target)?.parentElement;
    return element?.dataset.boardManualSize === "true"
      && Number(element.dataset.boardRequestedSize || 0) > 0;
  }, selector, { timeout: 5000 });
  const resized = await stage.evaluate((element) => ({
    requested: Number(element.dataset.boardRequestedSize || 0),
    rendered: Number(element.dataset.boardRenderedSize || 0),
    manual: element.dataset.boardManualSize
  }));
  assert.equal(resized.manual, "true", `${selector}: pointer resize did not enter manual sizing mode.`);
  assert(resized.requested > before.requested, `${selector}: pointer resize did not update requested size: ${JSON.stringify({ before, resized })}.`);
  assert.equal(await handle.getAttribute("aria-valuenow"), String(resized.requested), `${selector}: resize handle accessibility value drifted from the requested size.`);

  const fullscreenButton = stage.locator('[data-board-action="fullscreen"]');
  await fullscreenButton.scrollIntoViewIfNeeded();
  await fullscreenButton.click({ force: true });
  await page.waitForFunction((target) => {
    const stageElement = document.querySelector(target)?.parentElement;
    return document.fullscreenElement === stageElement
      && document.body.classList.contains("interactive-board-fullscreen-active");
  }, selector, { timeout: 5000 });
  const fullscreen = await board.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    requested: Number(element.parentElement?.dataset.boardRequestedSize || 0)
  }));
  assert(Math.abs(fullscreen.width - fullscreen.height) < 1, `${selector}: fullscreen board is not square.`);
  assert(fullscreen.width >= resized.rendered, `${selector}: fullscreen reduced the physical board unexpectedly: ${JSON.stringify({ resized, fullscreen })}.`);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction((target) => {
    const stageElement = document.querySelector(target)?.parentElement;
    return !document.fullscreenElement
      && !document.body.classList.contains("interactive-board-fullscreen-active")
      && stageElement?.dataset.boardManualSize === "true";
  }, selector, { timeout: 5000 });
  const restored = await stage.evaluate((element) => ({
    requested: Number(element.dataset.boardRequestedSize || 0),
    rendered: Number(element.dataset.boardRenderedSize || 0),
    manual: element.dataset.boardManualSize
  }));
  assert.equal(restored.requested, resized.requested, `${selector}: fullscreen did not restore the requested manual size.`);
  return { before, resized, fullscreen, restored };
}

async function runRuntimeContract(browser) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    serviceWorkers: "block"
  });
  await installOfflineSupabaseFixture(context);
  // The required chess module is local. Abort every jsDelivr request so this
  // test proves the board does not silently fall back to a CDN.
  await context.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  const page = await context.newPage();
  const localChessRequests = [];
  const externalChessRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/assets/vendor/chess.js-1.0.0.mjs")) localChessRequests.push(url);
    if (url.includes("cdn.jsdelivr.net/npm/chess.js@1.0.0")) externalChessRequests.push(url);
  });

  try {
    await page.goto(`${baseUrl}/#play`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await startPlayGame(page);
    assert(localChessRequests.length >= 1, "Play did not request the local chess.js vendor module.");
    assert.equal(externalChessRequests.length, 0, "Play attempted to load chess.js from jsDelivr.");
    const defaultPlay = await readBoardState(page, "#coachBoard");

    await setBoardScale(page, 82);
    await startPlayGame(page);
    await waitForBoardWidthBelow(page, defaultPlay.boardWidth);
    const reducedPlay = await readBoardState(page, "#coachBoard");
    assert(reducedPlay.boardWidth < defaultPlay.boardWidth - 20,
      `Play board scale preference did not reduce the rendered board: ${JSON.stringify({ defaultPlay, reducedPlay })}.`);
    assert.notEqual(reducedPlay.boardSizeVariable, defaultPlay.boardSizeVariable,
      "The Play board size preference did not update the section-owned sizing variable.");

    await page.locator('#coachBoard [data-square][draggable="true"]').first().waitFor({ state: "visible", timeout: 10000 });
    const playFrom = page.locator('#coachBoard [data-square][draggable="true"]').first();
    await playFrom.click();
    const playTarget = page.locator("#coachBoard [data-square].legal").first();
    await playTarget.waitFor({ state: "visible" });
    await playTarget.click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator("#coachBoard [data-square]").count(), 64,
      "Play lost its board squares after a real click-to-move.");
    assert.notEqual((await page.locator("#moveHistory").textContent()).trim(), "No moves yet.",
      "Play did not commit the real click-to-move.");

    await openRoute(page, "#puzzles");
    await waitForBoard(page, "#realPuzzleBoard");
    const puzzleFrom = page.locator('#realPuzzleBoard [data-square][draggable="true"]').first();
    await puzzleFrom.waitFor({ state: "visible", timeout: 10000 });
    await puzzleFrom.click();
    await page.locator("#realPuzzleBoard .real-puzzle-square.selected").waitFor({ state: "visible" });
    const puzzleTarget = page.locator("#realPuzzleBoard .real-puzzle-square.legal").first();
    await puzzleTarget.waitFor({ state: "visible" });
    const puzzleFeedbackBefore = (await page.locator("#realPuzzleFeedback").textContent()).trim();
    await puzzleTarget.click();
    await page.waitForFunction((before) => {
      const feedback = document.getElementById("realPuzzleFeedback")?.textContent.trim();
      return Boolean(feedback) && feedback !== before;
    }, puzzleFeedbackBefore, { timeout: 5000 });
    assert.equal((await page.locator("#realPuzzleBoard [data-square]").count()), 64,
      "Puzzle lost its board squares after a real move.");

    await startPlayGame(page);
    await verifyPointerResizeAndFullscreen(page, "#coachBoard");
  } finally {
    await context.close();
  }
}

async function runResponsiveBoardContract(browser) {
  const cases = [[1366, 768], [1366, 900], [1024, 768], [768, 1024], [390, 844]];
  const routes = [
    ["#tutorial", "#tutorialBoard"],
    ["#adventures", "#adventureBoard"],
    ["#openings", "#openingExplorerBoard"],
    ["#puzzles", "#realPuzzleBoard"]
  ];
  for (const [width, height] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await installOfflineSupabaseFixture(context);
    const page = await context.newPage();
    try {
      for (const [hash, selector] of routes) {
        await openRoute(page, hash);
        if (hash === "#openings") await waitForRouteStylesheet(page, "openings");
        await waitForBoard(page, selector);
      }
      await openRoute(page, "#bots");
      await startPlayGame(page);
      const playState = await readBoardState(page, "#coachBoard");
      assert(playState.boardWidth <= playState.stageWidth + 1, `#coachBoard: responsive board exceeded its stage at ${width}x${height}.`);
      assert.equal(playState.pageOverflow, false, `#coachBoard: responsive layout overflow at ${width}x${height}.`);
    } finally {
      await context.close();
    }
  }
}

async function main() {
  staticContract();
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer();
    await runRuntimeContract(browser);
    await runResponsiveBoardContract(browser);
    process.stdout.write("PASS board sizing and local chess runtime regression\n");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
