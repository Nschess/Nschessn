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
  const playCss = read("assets/play-lobby.css");
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
  assert.match(app, /const interactiveBoardDiscoveryStorageKey = "checkmateQuest\.boardSizingDiscovery\.v1"/,
    "The first-time board discovery cue must use shared persistence.");
  assert.match(app, /data-interactive-board-stage|\[data-interactive-board-stage\]/,
    "The shared board stage contract is missing.");
  assert.match(app, /data-board-resize-handle/,
    "The shared direct resize handle contract is missing.");
  assert.match(app, /requestFullscreen\?\.\(\{ navigationUI: "hide" \}\)/,
    "The shared board fullscreen host must use native fullscreen.");
  assert.match(app, /data-board-fullscreen-action/,
    "The shared board fullscreen action must be mounted by the global controller.");
  assert.match(app, /state\.isResizing/,
    "Live pointer resizing must be protected from saved-state reconciliation.");
  assert.match(css, /\.interactive-board-sizing-stage/,
    "The shared board sizing stage styles are missing.");
  assert.match(css, /\.interactive-board-fullscreen-host:fullscreen/,
    "The shared board fullscreen geometry styles are missing.");
  assert.match(app, /fullscreenRequested/,
    "Fullscreen must keep a temporary viewport-sized request separate from the saved normal board size.");
  assert.match(app, /visualViewport/,
    "Fullscreen sizing must measure the visual viewport when it is available.");
  assert.match(playCss, /100dvw/,
    "Play fullscreen geometry must use the dynamic viewport width.");
  assert.match(playCss, /100dvh/,
    "Play fullscreen geometry must use the dynamic viewport height.");
  assert.match(playCss, /\.interactive-board-actions\s*\{\s*opacity:\s*\.42/,
    "Fullscreen utility controls must stay subtle during active play.");
  assert.match(css, /\.interactive-board-resize-handle\s*\{[\s\S]*inline-size:\s*(?:5[28]|3[46]|2[89])px\s*!important/,
    "The shared resize handle must expose a usable pointer hit area.");
  assert.match(css, /\.interactive-board-fullscreen-button/,
    "The shared fullscreen control styling is missing.");
  assert.match(css, /\.interactive-board-discovery/,
    "The first-time resize discovery cue styling is missing.");
  assert.match(css, /\.interactive-board-stage-tools\s*\{[\s\S]*display:\s*none\s*!important/,
    "The legacy board control strip must remain globally hidden.");
  assert.match(css, /Review board contract:[\s\S]*?#gameReview\.is-review-page #reviewBoardSlot\s*\{[\s\S]*?grid-template-columns:\s*28px minmax\(0, 1fr\);[\s\S]*?gap:\s*0 8px;/,
    "Review must keep its evaluation rail and board in explicit layout tracks.");
  assert.match(css, /Review board contract:[\s\S]*?#gameReview\.is-review-page #reviewBoardSlot > \.play-board-wrap\s*\{[\s\S]*?grid-area:\s*auto\s*!important;[\s\S]*?grid-column:\s*2\s*!important;/,
    "Review board placement must not fall back to an implicit grid area.");
  assert.equal((app.match(/new ResizeObserver\(/g) || []).length, 1,
    "The global board sizing controller must keep one shared ResizeObserver.");
  assert.match(html, /data-interactive-board-stage/,
    "Interactive board stages must be wired in the shipped markup.");
  const installShellStart = serviceWorker.indexOf("const APP_SHELL");
  const installShellEnd = serviceWorker.indexOf('self.addEventListener("install"');
  const installShell = serviceWorker.slice(installShellStart, installShellEnd);
  assert.doesNotMatch(installShell, /assets\/vendor\/chess\.js-1\.0\.0\.mjs/,
    "The route-specific chess runtime must not block the initial offline shell install.");
  assert.match(serviceWorker, /caches\.match\(request\)\.then\(\(cached\) => cached \|\| fetch\(request\)/,
    "The local chess runtime must remain cacheable after its first route request.");
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
  try {
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
  } catch (error) {
    const probe = await page.evaluate((target) => {
      const board = document.querySelector(target);
      const stage = board?.closest("[data-interactive-board-stage]");
      const boardRect = board?.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      return {
        url: location.href,
        activePanel: document.querySelector("main > .is-active-panel")?.id || "",
        squares: board?.querySelectorAll("[data-square]").length || 0,
        board: boardRect ? [boardRect.width, boardRect.height] : null,
        stage: stageRect ? [stageRect.width, stageRect.height] : null
      };
    }, selector);
    throw new Error(`${selector}: board readiness timed out: ${JSON.stringify(probe)}`, { cause: error });
  }
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
    assert(state.frameWidths.every((width) => width <= state.workspaceWidth + 1),
      `${selector}: player frame exceeded the stable board workspace: ${JSON.stringify(state)}.`);
  }
  assert.equal(state.pageOverflow, false, `${selector}: board layout introduced page overflow.`);
  assert.equal(state.stageControls, false, `${selector}: the removed board control strip reappeared.`);
  assert.equal(state.resizeHandle, true, `${selector}: shared resize handle did not mount.`);
  assert(state.resizeHandleWidth >= 20, `${selector}: resize handle hit area is too narrow: ${JSON.stringify(state)}.`);
  assert.notEqual(state.resizeHandleTag, "BUTTON", `${selector}: resize must remain a direct drag zone, not a clickable button.`);
  assert.equal(state.resizeHandleRole, "separator", `${selector}: resize edge must expose a non-button separator role.`);
  assert.equal(state.fullscreenButton, true, `${selector}: shared fullscreen control did not mount.`);
  assert.equal(state.fullscreenButtonTitle, "Fullscreen — focus on your game",
    `${selector}: fullscreen control tooltip is missing or inconsistent.`);
  if (selector === "#coachBoard") {
    assert.equal(state.playerFrameCount, 2, `${selector}: active Play must keep both player frames around the board: ${JSON.stringify(state)}.`);
  }
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
      workspaceWidth: board?.closest(".match-board-column")?.getBoundingClientRect().width
        || board?.closest("[data-interactive-board-stage]")?.getBoundingClientRect().width || 0,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      frameWidths: [...(board?.closest(".match-board-column")?.querySelectorAll(".ai-player-card, .match-player-card") || [])]
        .map((frame) => frame.getBoundingClientRect().width),
      playerFrameCount: board?.closest(".match-board-column")?.querySelectorAll(":scope > .ai-player-card, :scope > .match-player-card").length || 0,
      stageControls: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-stage-tools]")),
      resizeHandle: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-resize-handle]")),
      resizeHandleWidth: board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-resize-handle]")?.getBoundingClientRect().width || 0,
      resizeHandleTag: board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-resize-handle]")?.tagName || "",
      resizeHandleRole: board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-resize-handle]")?.getAttribute("role") || "",
      fullscreenButton: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("button[data-board-fullscreen-action]")),
      fullscreenButtonTitle: board?.closest("[data-interactive-board-stage]")?.querySelector("button[data-board-fullscreen-action]")?.getAttribute("title") || "",
      discoveryVisible: Boolean(board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-discovery]")),
      discoveryText: board?.closest("[data-interactive-board-stage]")?.querySelector("[data-board-discovery]")?.textContent.trim() || ""
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
  await page.waitForFunction(() => document.querySelector('[data-settings-page="gameplay"]')?.classList.contains("is-active"), null, { timeout: 5000 });
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
  await page.waitForFunction(() => document.getElementById("aiGameReady")?.dataset.ready === "true", null, { timeout: 15000 });
  await page.locator("#aiGameReadyStart").click();
  await waitForBoard(page, "#coachBoard");
  await page.waitForTimeout(250);
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
  const handle = stage.locator("[data-board-resize-handle]");
  await handle.scrollIntoViewIfNeeded();
  const before = await stage.evaluate((element) => ({
    requested: Number(element.dataset.boardRequestedSize || 0),
    rendered: Number(element.dataset.boardRenderedSize || 0),
    manual: element.dataset.boardManualSize
  }));
  const cardsBeforeResize = await page.evaluate(() => [...document.querySelectorAll("#aiPlayerCard, #matchPlayerCard")]
    .map((card) => {
      const rect = card.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
  const handleBox = await handle.boundingBox();
  assert(handleBox, `${selector}: direct resize handle was not measurable.`);
  // A narrow responsive stage can already clamp the saved request below the
  // user's preferred size. Drag in the direction that remains inside the
  // current fit so this assertion tests the live pointer contract rather than
  // an impossible positive resize.
  const normalResizeDelta = before.rendered < before.requested ? -72 : 72;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + normalResizeDelta, handleBox.y + handleBox.height / 2 + normalResizeDelta, { steps: 4 });
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
  const cardsAfterResize = await page.evaluate(() => [...document.querySelectorAll("#aiPlayerCard, #matchPlayerCard")]
    .map((card) => {
      const rect = card.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
  assert.equal(cardsAfterResize.length, cardsBeforeResize.length,
    `${selector}: board resize changed the player-card count.`);
  cardsAfterResize.forEach((card, index) => {
    assert(Math.abs(card.width - cardsBeforeResize[index].width) < 1
      && Math.abs(card.height - cardsBeforeResize[index].height) < 1,
    `${selector}: board resize changed player-card geometry: ${JSON.stringify({ cardsBeforeResize, cardsAfterResize })}.`);
  });
  assert.equal(resized.manual, "true", `${selector}: pointer resize did not enter manual sizing mode.`);
  assert.notEqual(resized.requested, before.requested, `${selector}: pointer resize did not update requested size: ${JSON.stringify({ before, resized })}.`);
  assert.equal(await handle.getAttribute("aria-valuenow"), String(resized.requested), `${selector}: resize handle accessibility value drifted from the requested size.`);
  const discovery = await stage.locator("[data-board-discovery]").count();
  assert.equal(discovery, 0, `${selector}: first successful resize should dismiss the discovery cue.`);

  const fullscreenButton = stage.locator("button[data-board-fullscreen-action]");
  await fullscreenButton.click({ force: true });
  await page.waitForFunction((target) => {
    const stageElement = document.querySelector(target)?.parentElement;
    const fullscreenHost = stageElement?.closest("#play.is-active-game:not(.is-review-mode) .match-board-column") || stageElement;
    return document.fullscreenElement === fullscreenHost
      && document.body.classList.contains("interactive-board-fullscreen-active");
  }, selector, { timeout: 5000 });
  const fullscreen = await board.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    requested: Number(element.parentElement?.dataset.boardRequestedSize || 0),
    fullscreenSize: Number(element.parentElement?.dataset.boardFullscreenSize || 0)
  }));
  assert(Math.abs(fullscreen.width - fullscreen.height) < 1, `${selector}: fullscreen board is not square.`);
  const fullscreenSeats = await page.evaluate(() => {
    const host = document.fullscreenElement;
    return {
      hostIsPlayWorkspace: Boolean(host?.matches?.(".match-board-column")),
      cardsInsideHost: Boolean(host?.querySelector?.("#aiPlayerCard") && host?.querySelector?.("#matchPlayerCard")),
      cardsHaveGeometry: ["#aiPlayerCard", "#matchPlayerCard"].every((target) => {
        const rect = host?.querySelector(target)?.getBoundingClientRect();
        return Boolean(rect?.width && rect?.height);
      })
    };
  });
  if (fullscreenSeats.hostIsPlayWorkspace) {
    assert(fullscreenSeats.cardsInsideHost && fullscreenSeats.cardsHaveGeometry,
      `${selector}: fullscreen Play workspace lost its player cards: ${JSON.stringify(fullscreenSeats)}.`);
    assert(fullscreen.width >= 480,
      `${selector}: fullscreen board became too small while fitting player cards: ${JSON.stringify({ resized, fullscreen })}.`);
  } else {
    assert(fullscreen.width >= resized.rendered, `${selector}: fullscreen reduced the physical board unexpectedly: ${JSON.stringify({ resized, fullscreen })}.`);
  }

  const fullscreenHandle = stage.locator("[data-board-resize-handle]");
  assert.equal(await fullscreenHandle.boundingBox(), null,
    `${selector}: normal-mode resize handle remained visible in fullscreen.`);

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
  assert.equal(restored.requested, resized.requested, `${selector}: fullscreen did not restore the normal requested manual size.`);

  const handleAfterFullscreen = stage.locator("[data-board-resize-handle]");
  await handleAfterFullscreen.scrollIntoViewIfNeeded();
  const afterBox = await handleAfterFullscreen.boundingBox();
  assert(afterBox, `${selector}: resize handle disappeared after fullscreen exit.`);
  await page.mouse.move(afterBox.x + afterBox.width / 2, afterBox.y + afterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(afterBox.x + afterBox.width / 2 - 44, afterBox.y + afterBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(({ target, previous }) => {
    const element = document.querySelector(target)?.parentElement;
    return element?.dataset.boardManualSize === "true"
      && Number(element.dataset.boardRequestedSize || 0) < previous;
  }, { target: selector, previous: restored.requested }, { timeout: 5000 });
  const resizedAgain = await stage.evaluate((element) => ({
    requested: Number(element.dataset.boardRequestedSize || 0),
    rendered: Number(element.dataset.boardRenderedSize || 0),
    manual: element.dataset.boardManualSize
  }));
  return { before, resized, fullscreen, restored: resizedAgain };
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
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    if (typeof NativeResizeObserver !== "function") return;
    window.__boardResizeObserverCallbackCount = 0;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super((...args) => {
          window.__boardResizeObserverCallbackCount += 1;
          callback(...args);
        });
      }
    };
  });
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
    const firstTimeCue = page.locator('#coachBoard').locator('xpath=..').locator('[data-board-discovery]');
    await firstTimeCue.waitFor({ state: "visible", timeout: 5000 });
    assert.match((await firstTimeCue.textContent()) || "", /Drag to resize/,
      "A new player was not shown the board resize discovery cue.");
    assert.match((await firstTimeCue.textContent()) || "", /Fullscreen/i,
      "The board discovery cue did not mention fullscreen.");
    const resizeObserverCallbacksBefore = await page.evaluate(() => window.__boardResizeObserverCallbackCount || 0);
    await page.waitForTimeout(900);
    const resizeObserverCallbacksAfter = await page.evaluate(() => window.__boardResizeObserverCallbackCount || 0);
    assert(resizeObserverCallbacksAfter - resizeObserverCallbacksBefore <= 3,
      `The shared board ResizeObserver is firing continuously after layout settles: ${JSON.stringify({
        before: resizeObserverCallbacksBefore,
        after: resizeObserverCallbacksAfter,
        delta: resizeObserverCallbacksAfter - resizeObserverCallbacksBefore
      })}.`);
    assert(localChessRequests.length >= 1, "Play did not request the local chess.js vendor module.");
    assert.equal(externalChessRequests.length, 0, "Play attempted to load chess.js from jsDelivr.");
    const defaultPlay = await readBoardState(page, "#coachBoard");

    await setBoardScale(page, 82);
    await startPlayGame(page);
    await page.waitForFunction((expected) => {
      const stage = document.querySelector("#coachBoard")?.parentElement;
      return stage?.dataset.boardRequestedSize === String(expected);
    }, 590, { timeout: 5000 });
    const reducedPlay = await readBoardState(page, "#coachBoard");
    assert(Number.parseFloat(reducedPlay.boardSizeVariable) < Number.parseFloat(defaultPlay.boardSizeVariable),
      `Play board scale preference did not resolve a smaller requested board size: ${JSON.stringify({ defaultPlay, reducedPlay })}.`);

    await page.locator('#coachBoard [data-square][draggable="true"]').first().waitFor({ state: "visible", timeout: 10000 });
    const playFrom = page.locator('#coachBoard [data-square][draggable="true"]').first();
    await playFrom.click();
    const playTarget = page.locator("#coachBoard [data-square].legal").first();
    await playTarget.waitFor({ state: "visible" });
    await playTarget.click();
    await page.waitForFunction(() => {
      const history = document.getElementById("moveHistory")?.textContent.trim();
      return Boolean(history) && history !== "No moves yet.";
    }, { timeout: 5000 });
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
    const resized = await verifyPointerResizeAndFullscreen(page, "#coachBoard");
    await openRoute(page, "#puzzles");
    await waitForBoard(page, "#realPuzzleBoard");
    await page.waitForFunction((expected) => {
      const stage = document.querySelector("#realPuzzleBoard")?.parentElement;
      return Number(stage?.dataset.boardRequestedSize || 0) === expected;
    }, resized.restored.requested, { timeout: 5000 });
    const puzzleAfterResize = await readBoardState(page, "#realPuzzleBoard");
    const puzzleRequested = await page.locator("#realPuzzleBoard").locator("xpath=..").getAttribute("data-board-requested-size");
    assert.equal(Number(puzzleRequested), resized.restored.requested,
      "Puzzle did not inherit the globally persisted manual board size.");
    assert.equal(puzzleAfterResize.stageControls, false,
      "Puzzle reintroduced the removed board control strip during navigation.");
  } finally {
    await context.close();
  }
}

async function runResponsiveBoardContract(browser) {
  const cases = [[1366, 768], [1366, 900], [1024, 768], [768, 1024], [624, 900], [390, 844]];
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

async function readFullscreenBoardState(page) {
  return page.evaluate(() => {
    const board = document.querySelector("#coachBoard");
    const stage = board?.parentElement;
    const host = document.fullscreenElement;
    const boardRect = board?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const cards = [...(host?.querySelectorAll?.(":scope > .ai-player-card, :scope > .match-player-card") || [])]
      .map((card) => {
        const rect = card.getBoundingClientRect();
        return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
      });
    const hostStyle = host ? getComputedStyle(host) : null;
    const hostRect = host?.getBoundingClientRect();
    const paddingInline = (Number.parseFloat(hostStyle?.paddingInlineStart) || 0)
      + (Number.parseFloat(hostStyle?.paddingInlineEnd) || 0);
    const paddingBlock = (Number.parseFloat(hostStyle?.paddingBlockStart) || 0)
      + (Number.parseFloat(hostStyle?.paddingBlockEnd) || 0);
    const rowGap = Number.parseFloat(hostStyle?.rowGap || hostStyle?.gap || "") || 0;
    const utility = [...(host?.querySelectorAll?.(".play-lobby-board-actions") || [])]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .find(({ rect }) => rect.width > 0 && rect.height > 0);
    const measuredUtilityReserve = utility && hostRect && utility.rect.right >= hostRect.right - 1
      ? 0
      : utility && stageRect && utility.rect.left >= stageRect.right
      ? utility.rect.width + Math.max(0, utility.rect.left - stageRect.right)
      : 0;
    const controllerUtilityReserve = Number.parseFloat(
      host?.style.getPropertyValue("--interactive-board-utility-reserve") || ""
    ) || 0;
    const utilityRailReserve = Math.max(measuredUtilityReserve, controllerUtilityReserve);
    const boardFrameReserve = Math.max(0, Number(stageRect?.width || 0) - Number(boardRect?.width || 0));
    const fullscreenRows = 1 + cards.length;
    const safeWidth = (host?.clientWidth || 0) - paddingInline - utilityRailReserve - boardFrameReserve;
    const safeHeight = (host?.clientHeight || 0) - paddingBlock
      - cards.reduce((total, card) => total + card.height, 0)
      - rowGap * Math.max(0, fullscreenRows - 1)
      - boardFrameReserve;
    return {
      boardWidth: boardRect?.width || 0,
      boardHeight: boardRect?.height || 0,
      boardRect: boardRect ? { left: boardRect.left, right: boardRect.right, top: boardRect.top, bottom: boardRect.bottom } : null,
      requested: Number(stage?.dataset.boardRequestedSize || 0),
      fullscreenSize: Number(stage?.dataset.boardFullscreenSize || 0),
      rendered: Number(stage?.dataset.boardRenderedSize || 0),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      hostWidth: host?.clientWidth || 0,
      hostHeight: host?.clientHeight || 0,
      hostScrollWidth: host?.scrollWidth || 0,
      hostScrollHeight: host?.scrollHeight || 0,
      hostOverflowX: hostStyle?.overflowX || "",
      hostOverflowY: hostStyle?.overflowY || "",
      hostBoxSizing: hostStyle?.boxSizing || "",
      hostPaddingInline: paddingInline,
      hostPaddingBlock: paddingBlock,
      hostRowGap: rowGap,
      boardFrameReserve,
      utilityRailReserve,
      safeWidth,
      safeHeight,
      maxSafeBoard: Math.floor(Math.min(1200, safeWidth, safeHeight)),
      pageOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      cards,
      stageRect: stageRect ? { left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom, width: stageRect.width, height: stageRect.height } : null,
      utilityRect: utility ? { left: utility.rect.left, right: utility.rect.right, top: utility.rect.top, bottom: utility.rect.bottom, width: utility.rect.width, height: utility.rect.height } : null
      ,children: [...(host?.children || [])].map((child) => {
        const rect = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return { className: child.className, display: style.display, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }).filter((child) => child.width > 0 && child.height > 0)
    };
  });
}

async function runFullscreenResponsiveContract(browser) {
  const cases = [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [1009, 1074], [957, 956], [949, 1080], [768, 1024], [624, 844], [390, 844]];
  const measurements = [];
  for (const [width, height] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await installOfflineSupabaseFixture(context);
    const page = await context.newPage();
    try {
      await openRoute(page, "#bots");
      await startPlayGame(page);
      const normal = await readBoardState(page, "#coachBoard");
      const normalRequested = Number(await page.locator("#coachBoard").locator("xpath=..").getAttribute("data-board-requested-size"));
      const fullscreenButton = page.locator("#coachBoard").locator("xpath=..").getByRole("button", { name: "Fullscreen — focus on your game" });
      await fullscreenButton.waitFor({ state: "visible" });
      await fullscreenButton.scrollIntoViewIfNeeded();
      // Keep the semantic control in the viewport center. The sticky site
      // header can intercept a nearest-edge scroll at small heights even
      // though the fullscreen button itself is visible and actionable.
      await fullscreenButton.evaluate((button) => {
        button.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      });
      const clickFullscreen = async () => {
        // Use the semantic locator to derive the current hit target, then
        // click that target without letting locator.click() perform a second
        // nearest-edge scroll beneath the sticky header.
        const box = await fullscreenButton.boundingBox();
        assert(box, "Fullscreen control lost its measurable hit area after centering.");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      await clickFullscreen();
      const fullscreenReady = () => page.waitForFunction(() => Boolean(document.fullscreenElement)
        && document.body.classList.contains("interactive-board-fullscreen-active")
        && Number(document.querySelector("#coachBoard")?.parentElement?.dataset.boardFullscreenSize || 0) > 0, undefined, { timeout: 5000 });
      try {
        await fullscreenReady();
      } catch (error) {
        // A prior context can leave Chromium's first fullscreen activation
        // request rejected even though the real button is present. Retry the
        // same user-facing control once before classifying the browser run.
        await clickFullscreen();
        await fullscreenReady().catch(() => { throw error; });
      }
      const focused = await readFullscreenBoardState(page);
      const minimumBoard = width >= 1800 ? 700 : width >= 1000 ? 480 : width >= 600 ? 480 : 300;
      assert(Math.abs(focused.boardWidth - focused.boardHeight) < 1,
        `fullscreen ${width}x${height}: board is not square: ${JSON.stringify(focused)}.`);
      assert(focused.boardWidth >= minimumBoard,
        `fullscreen ${width}x${height}: board did not use the available viewport: ${JSON.stringify({ normal, focused })}.`);
      assert(focused.cards.length >= 2 && focused.cards.every((card) => card.width > 0 && card.height > 0),
        `fullscreen ${width}x${height}: player cards are not visible around the board: ${JSON.stringify(focused)}.`);
      assert(focused.boardWidth <= focused.hostWidth + 1 && focused.boardHeight <= focused.hostHeight + 1,
        `fullscreen ${width}x${height}: board exceeded the fullscreen host: ${JSON.stringify(focused)}.`);
      assert(focused.boardWidth >= focused.maxSafeBoard - 2,
        `fullscreen ${width}x${height}: board did not reach the maximum measured safe square: ${JSON.stringify(focused)}.`);
      assert(focused.utilityRailReserve === 0 || focused.utilityRect?.right <= focused.hostWidth + 1,
        `fullscreen ${width}x${height}: utility control rail is clipped: ${JSON.stringify(focused)}.`);
      if (focused.utilityRect && focused.boardRect) {
        const controlOutsideBoard = focused.utilityRect.left >= focused.boardRect.right - 1
          || focused.utilityRect.right <= focused.boardRect.left + 1
          || focused.utilityRect.top >= focused.boardRect.bottom - 1
          || focused.utilityRect.bottom <= focused.boardRect.top + 1;
        assert(controlOutsideBoard,
          `fullscreen ${width}x${height}: utility control overlaps the board pointer surface: ${JSON.stringify(focused)}.`);
      }
      assert(focused.hostScrollWidth <= focused.hostWidth + 1 && focused.hostScrollHeight <= focused.hostHeight + 1,
        `fullscreen ${width}x${height}: fullscreen workspace introduced internal scrolling: ${JSON.stringify(focused)}.`);
      assert.equal(focused.hostBoxSizing, "border-box",
        `fullscreen ${width}x${height}: fullscreen host must size from its border-box: ${JSON.stringify(focused)}.`);
      assert.equal(focused.pageOverflowX, false,
        `fullscreen ${width}x${height}: fullscreen introduced horizontal page overflow: ${JSON.stringify(focused)}.`);
      assert.equal(focused.bodyOverflowX, "hidden",
        `fullscreen ${width}x${height}: page scrolling was not locked while focused: ${JSON.stringify(focused)}.`);
      if (width >= 1000) {
        const top = Math.min(...focused.children.map((child) => child.top));
        const bottom = Math.max(...focused.children.map((child) => child.bottom));
        const topGap = top;
        const bottomGap = focused.hostHeight - bottom;
        const intentionalGap = Math.max(48, focused.hostHeight * .1);
        assert(topGap <= intentionalGap && bottomGap <= intentionalGap,
          `fullscreen ${width}x${height}: unused top/bottom bands are too large: ${JSON.stringify({ topGap, bottomGap, intentionalGap, focused })}.`);
        assert(focused.boardWidth >= focused.hostHeight * .66,
          `fullscreen ${width}x${height}: board is not the dominant workspace element: ${JSON.stringify(focused)}.`);
      }
      measurements.push({
        viewport: `${width}x${height}`,
        host: `${focused.hostWidth}x${focused.hostHeight}`,
        board: Math.round(focused.boardWidth),
        gaps: {
          top: Math.round(focused.boardRect?.top || 0),
          bottom: Math.round(focused.hostHeight - (focused.boardRect?.bottom || 0)),
          left: Math.round(focused.boardRect?.left || 0),
          right: Math.round(focused.hostWidth - (focused.boardRect?.right || 0))
        },
        maxSafe: focused.maxSafeBoard,
        rail: Math.round(focused.utilityRailReserve)
      });

      const fullscreenHandle = page.locator("#coachBoard").locator("xpath=..").locator("[data-board-resize-handle]");
      assert.equal(await fullscreenHandle.boundingBox(), null,
        `fullscreen ${width}x${height}: normal-mode resize handle remained visible in fullscreen.`);

      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction((expected) => !document.fullscreenElement
        && !document.body.classList.contains("interactive-board-fullscreen-active")
        && Number(document.querySelector("#coachBoard")?.parentElement?.dataset.boardRequestedSize || 0) === expected,
      normalRequested, { timeout: 5000 });
      const restored = await readBoardState(page, "#coachBoard");
      assert(Math.abs(restored.boardWidth - normal.boardWidth) < 2,
        `fullscreen ${width}x${height}: exiting focus mode did not restore the normal board size: ${JSON.stringify({ normal, restored })}.`);

      const postFullscreenHandle = page.locator("#coachBoard").locator("xpath=..").locator("[data-board-resize-handle]");
      const postFullscreenHandleBox = await postFullscreenHandle.boundingBox();
      assert(postFullscreenHandleBox, `fullscreen ${width}x${height}: normal resize handle disappeared after exit.`);
      const postFullscreenRequested = Number(await page.locator("#coachBoard").locator("xpath=..").getAttribute("data-board-requested-size"));
      await page.mouse.move(postFullscreenHandleBox.x + postFullscreenHandleBox.width / 2, postFullscreenHandleBox.y + postFullscreenHandleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(postFullscreenHandleBox.x + postFullscreenHandleBox.width / 2 - 18, postFullscreenHandleBox.y + postFullscreenHandleBox.height / 2 - 18, { steps: 3 });
      await page.mouse.up();
      await page.waitForFunction((previous) => Number(document.querySelector("#coachBoard")?.parentElement?.dataset.boardRequestedSize || 0) < previous,
        postFullscreenRequested, { timeout: 5000 });
    } finally {
      if (await page.evaluate(() => Boolean(document.fullscreenElement)).catch(() => false)) {
        await page.evaluate(() => document.exitFullscreen()).catch(() => {});
      }
      await context.close();
    }
  }
  return measurements;
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
    const fullscreenMeasurements = await runFullscreenResponsiveContract(browser);
    await runRuntimeContract(browser);
    await runResponsiveBoardContract(browser);
    process.stdout.write(`PASS board sizing and local chess runtime regression ${JSON.stringify(fullscreenMeasurements)}\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
