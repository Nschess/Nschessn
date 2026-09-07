const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { parseEnvFile } = require("./e2e-config.cjs");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4175;
const baseUrl = `http://127.0.0.1:${port}`;
const e2eEnv = parseEnvFile(path.join(root, ".env.e2e"));

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const request = http.get(`${baseUrl}/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        request.destroy();
        retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > 15000) reject(new Error("Board drag-size test server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function waitForBoard(page, selector) {
  await page.waitForFunction((target) => {
    const board = document.querySelector(target);
    const square = board?.querySelector("[data-square]");
    const piece = board?.querySelector(".piece-svg");
    if (!board || !square || !piece || board.querySelectorAll("[data-square]").length !== 64) return false;
    const boardRect = board.getBoundingClientRect();
    return boardRect.width >= 100 && boardRect.height >= 100
      && piece.getBoundingClientRect().width > 0
      && piece.getBoundingClientRect().height > 0;
  }, selector, { timeout: 15000 });
}

async function startPlay(page) {
  await page.goto(`${baseUrl}/#bots`, { waitUntil: "domcontentloaded" });
  const bot = page.locator("#aiBotRoster [data-ai-bot-play]").first();
  await bot.waitFor({ state: "visible" });
  await bot.click();
  await page.locator("#aiGameReady").waitFor({ state: "visible" });
  await page.locator("#aiGameReadyStart").click();
  await waitForBoard(page, "#coachBoard");
  await page.waitForFunction(() => [...document.querySelectorAll("#coachBoard [data-square]")].some((square) => square.draggable), null, { timeout: 12000 });
}

async function setBoardScale(page, value) {
  await page.goto(`${baseUrl}/#settings`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-settings-tab="gameplay"]').click();
  const slider = page.locator('input[data-pref-setting="boardScale"]');
  await slider.waitFor({ state: "visible" });
  await slider.evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await page.waitForFunction((expected) => {
    try { return Number(JSON.parse(localStorage.getItem("checkmateQuest.preferences.v1") || "{}").boardScale) === expected; }
    catch { return false; }
  }, value);
}

async function resizeViewport(page, selector, width, height) {
  const before = await page.locator(selector).evaluate((board) => board.getBoundingClientRect().width);
  await page.setViewportSize({ width, height });
  await page.waitForFunction(({ target, previous }) => {
    const widthNow = document.querySelector(target)?.getBoundingClientRect().width || 0;
    return widthNow > 100 && Math.abs(widthNow - previous) > 10;
  }, { target: selector, previous: before }, { timeout: 5000 });
  await page.waitForTimeout(80);
}

async function enterFullscreen(page, selector) {
  const button = page.locator(`${selector} .interactive-board-fullscreen-button:visible`).first();
  if (await button.count()) {
    await button.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await button.click({ force: true });
    await page.waitForFunction(() => document.body.classList.contains("interactive-board-fullscreen-active"), null, { timeout: 5000 });
  } else {
    await page.evaluate(async (target) => {
      const board = document.querySelector(target);
      if (!(board instanceof HTMLElement) || typeof board.requestFullscreen !== "function") throw new Error(`No fullscreen host for ${target}.`);
      await board.requestFullscreen();
    }, selector);
    await page.waitForFunction((target) => document.fullscreenElement === document.querySelector(target), selector, { timeout: 5000 });
  }
  await page.waitForTimeout(100);
}

async function leaveFullscreen(page) {
  const nativeFullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
  if (nativeFullscreen) {
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  } else {
    const button = page.locator(".interactive-board-fullscreen-button:visible").first();
    await button.click({ force: true });
    await page.waitForFunction(() => !document.body.classList.contains("interactive-board-fullscreen-active"), null, { timeout: 5000 });
  }
  await page.waitForTimeout(80);
}

async function measureHeldDrag(page, selector, label, { requiresDraggable = true } = {}) {
  const source = requiresDraggable
    ? page.locator(`${selector} [data-square][draggable="true"]`).first()
    : page.locator(`${selector} [data-square]`).filter({ has: page.locator(".piece-svg") }).first();
  await source.scrollIntoViewIfNeeded();
  const sourceName = await source.getAttribute("data-square");
  const box = await source.boundingBox();
  assert(sourceName && box, `${label}: draggable source was not measurable.`);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 14, center.y, { steps: 2 });
  await page.waitForFunction(() => Boolean(document.querySelector(".board-drag-ghost")), null, { timeout: 5000 });
  const geometry = await page.evaluate(({ target, name, mode }) => {
    const sourcePiece = document.querySelector(`${target} [data-square="${name}"] .piece-svg, ${target} [data-square="${name}"] .piece-symbol, ${target} [data-square="${name}"] img`);
    const ghost = document.querySelector(".board-drag-ghost");
    const board = document.querySelector(target);
    const rect = (element) => element?.getBoundingClientRect().toJSON() || null;
    const style = ghost ? getComputedStyle(ghost) : null;
    return {
      label: mode,
      source: rect(sourcePiece),
      ghost: rect(ghost),
      board: rect(board),
      ghostInline: ghost ? { width: ghost.style.width, height: ghost.style.height, maxWidth: ghost.style.maxWidth, maxHeight: ghost.style.maxHeight } : null,
      ghostComputed: style ? { width: style.width, height: style.height, maxWidth: style.maxWidth, maxHeight: style.maxHeight } : null
    };
  }, { target: selector, name: sourceName, mode: label });
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector(".board-drag-ghost"), null, { timeout: 5000 });
  assert(geometry.source && geometry.ghost, `${label}: source or ghost geometry was missing: ${JSON.stringify(geometry)}.`);
  const tolerance = Math.max(2, geometry.source.width * 0.03, geometry.source.height * 0.03);
  assert(Math.abs(geometry.source.width - geometry.ghost.width) <= tolerance && Math.abs(geometry.source.height - geometry.ghost.height) <= tolerance,
    `${label}: drag ghost does not match the current rendered piece: ${JSON.stringify(geometry)}.`);
  return geometry;
}

async function resizeWithKeyboard(page, key, selector) {
  const handle = page.locator(`[data-board-resize-handle="${key}"]`);
  const before = await page.locator(selector).evaluate((board) => Number(board.closest(".interactive-board-sizing-target")?.dataset.boardRenderedSize || 0));
  await handle.focus();
  await page.keyboard.press(key === "play" ? "Home" : "End");
  await page.waitForFunction(({ target, previous }) => Number(document.querySelector(target)?.closest(".interactive-board-sizing-target")?.dataset.boardRenderedSize || 0) !== previous,
    { target: selector, previous: before }, { timeout: 5000 });
  await page.waitForTimeout(50);
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: {
      ...process.env,
      E2E_PORT: String(port),
      E2E_SUPABASE_URL: process.env.E2E_SUPABASE_URL || e2eEnv.E2E_SUPABASE_URL || "",
      E2E_SUPABASE_ANON_KEY: process.env.E2E_SUPABASE_ANON_KEY || e2eEnv.E2E_SUPABASE_ANON_KEY || ""
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer();
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await installOfflineSupabaseFixture(context);
    await installOptionalCdnFixtures(context);
    const page = await context.newPage();
    await startPlay(page);
    const normal = await measureHeldDrag(page, "#coachBoard", "Play normal");
    await setBoardScale(page, 82);
    await startPlay(page);
    const small = await measureHeldDrag(page, "#coachBoard", "Play small");
    await setBoardScale(page, 122);
    await startPlay(page);
    const large = await measureHeldDrag(page, "#coachBoard", "Play large");
    assert(large.board.width > small.board.width + 20, `Play resize did not materially change the board geometry: ${JSON.stringify({ small, large })}.`);
    assert(large.source.width > small.source.width * 1.05, `Play resize did not materially change current piece geometry: ${JSON.stringify({ small, large })}.`);

    await enterFullscreen(page, "#coachBoard");
    const fullscreen = await measureHeldDrag(page, "#coachBoard", "Play fullscreen");
    assert(fullscreen.source.width > 0 && fullscreen.ghost.width > 0, `Play fullscreen drag geometry was unavailable: ${JSON.stringify(fullscreen)}.`);
    await leaveFullscreen(page);

    await page.goto(`${baseUrl}/#puzzles`, { waitUntil: "domcontentloaded" });
    await waitForBoard(page, "#realPuzzleBoard");
    const puzzle = await measureHeldDrag(page, "#realPuzzleBoard", "Puzzle after route change");
    await resizeViewport(page, "#realPuzzleBoard", 390, 600);
    const puzzleSmall = await measureHeldDrag(page, "#realPuzzleBoard", "Puzzle resized small");
    assert(puzzleSmall.source.width < puzzle.source.width - 10, `Puzzle resize did not materially change current piece geometry: ${JSON.stringify({ puzzle, puzzleSmall })}.`);
    await enterFullscreen(page, "#realPuzzleBoard");
    const puzzleFullscreen = await measureHeldDrag(page, "#realPuzzleBoard", "Puzzle fullscreen");
    assert(puzzleFullscreen.source.width > 0 && puzzleFullscreen.ghost.width > 0, `Puzzle fullscreen drag geometry was unavailable: ${JSON.stringify(puzzleFullscreen)}.`);
    await leaveFullscreen(page);

    await page.goto(`${baseUrl}/#tutorial`, { waitUntil: "domcontentloaded" });
    await waitForBoard(page, "#tutorialBoard");
    const tutorial = await measureHeldDrag(page, "#tutorialBoard", "Tutorial after route change", { requiresDraggable: false });

    await context.close();
    process.stdout.write(`PASS drag ghost sizing regression (${[normal, small, large, fullscreen, puzzle, puzzleSmall, puzzleFullscreen, tutorial].map((item) => `${item.label}:${Math.round(item.source.width)}=${Math.round(item.ghost.width)}`).join(", ")})\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
