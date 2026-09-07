const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { parseEnvFile } = require("./e2e-config.cjs");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4177;
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
      if (Date.now() - started > 15000) reject(new Error("Board drag-follow test server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function waitForBoard(page, selector) {
  await page.waitForFunction((target) => {
    const board = document.querySelector(target);
    const square = board?.querySelector("[data-square]");
    const piece = board?.querySelector(".piece-svg, .piece-symbol, img");
    if (!board || !square || !piece || board.querySelectorAll("[data-square]").length !== 64) return false;
    const boardRect = board.getBoundingClientRect();
    const pieceRect = piece.getBoundingClientRect();
    return boardRect.width >= 100 && boardRect.height >= 100 && pieceRect.width > 0 && pieceRect.height > 0;
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
  await page.waitForTimeout(120);
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

async function readGeometry(page, selector, source) {
  return page.evaluate(({ target, name }) => {
    const board = document.querySelector(target);
    const square = board?.querySelector(`[data-square="${name}"]`);
    const piece = square?.querySelector(".piece-svg, .piece-symbol, img");
    const rect = (element) => element?.getBoundingClientRect().toJSON() || null;
    const boardRect = rect(board);
    const pieceRect = rect(piece);
    return {
      board: boardRect,
      piece: pieceRect,
      scrollY: window.scrollY,
      boardSize: boardRect?.width || 0,
      anchor: pieceRect ? { x: pieceRect.x + pieceRect.width * 0.27, y: pieceRect.y + pieceRect.height * 0.36 } : null
    };
  }, { target: selector, name: source });
}

async function readGhost(page, selector, point) {
  return page.evaluate(({ target, point: expectedPoint }) => {
    const board = document.querySelector(target);
    const ghost = document.querySelector(".board-drag-ghost");
    const parent = ghost?.parentElement;
    const rect = (element) => element?.getBoundingClientRect().toJSON() || null;
    const ghostRect = rect(ghost);
    const style = ghost ? getComputedStyle(ghost) : null;
    const parentStyle = parent ? getComputedStyle(parent) : null;
    const ancestors = [];
    for (let ancestor = parent; ancestor && ancestors.length < 8; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      ancestors.push({
        tag: ancestor.tagName,
        className: ancestor.className,
        rect: rect(ancestor),
        position: ancestorStyle.position,
        transform: ancestorStyle.transform,
        filter: ancestorStyle.filter,
        contain: ancestorStyle.contain,
        willChange: ancestorStyle.willChange
      });
    }
    return {
      point: expectedPoint,
      fullscreenElement: document.fullscreenElement?.className || null,
      board: rect(board),
      ghost: ghostRect,
      ghostStyle: style ? {
        left: ghost.style.left,
        top: ghost.style.top,
        transform: style.transform,
        position: style.position,
        pointerEvents: style.pointerEvents
      } : null,
      parent: parent?.className || parent?.tagName || null,
      parentRect: rect(parent),
      parentStyle: parentStyle ? {
        position: parentStyle.position,
        transform: parentStyle.transform,
        filter: parentStyle.filter,
        contain: parentStyle.contain,
        willChange: parentStyle.willChange,
        padding: parentStyle.padding,
        border: parentStyle.border,
        overflow: parentStyle.overflow
      } : null,
      ancestors
    };
  }, { target: selector, point });
}

async function trackHeldDrag(page, selector, label) {
  const source = page.locator(`${selector} [data-square][draggable="true"]`).first();
  await source.scrollIntoViewIfNeeded();
  const sourceName = await source.getAttribute("data-square");
  assert(sourceName, `${label}: no draggable source was found.`);
  const geometry = await readGeometry(page, selector, sourceName);
  assert(geometry.anchor && geometry.piece && geometry.board, `${label}: source geometry was unavailable: ${JSON.stringify(geometry)}.`);

  const anchor = geometry.anchor;
  const excursion = {
    x: Math.min(geometry.board.x + geometry.board.width - 4, anchor.x + Math.max(34, Math.min(160, geometry.board.width * 0.28))),
    y: Math.min(geometry.board.y + geometry.board.height - 4, anchor.y + Math.max(28, Math.min(140, geometry.board.height * 0.23)))
  };
  const points = [
    anchor,
    { x: anchor.x + 8, y: anchor.y + 6 },
    { x: anchor.x + (excursion.x - anchor.x) * 0.25, y: anchor.y + (excursion.y - anchor.y) * 0.25 },
    { x: anchor.x + (excursion.x - anchor.x) * 0.5, y: anchor.y + (excursion.y - anchor.y) * 0.5 },
    { x: anchor.x + (excursion.x - anchor.x) * 0.75, y: anchor.y + (excursion.y - anchor.y) * 0.75 },
    excursion,
    { x: anchor.x + (excursion.x - anchor.x) * 0.5, y: anchor.y + (excursion.y - anchor.y) * 0.5 },
    anchor
  ];

  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  const samples = [];
  try {
    for (const point of points.slice(1)) {
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(24);
      if (!samples.length) {
        await page.waitForFunction(() => Boolean(document.querySelector(".board-drag-ghost")), null, { timeout: 5000 });
      }
      const sample = await readGhost(page, selector, point);
      assert(sample.ghost, `${label}: ghost did not appear while dragging.`);
      samples.push(sample);
    }
  } finally {
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector(".board-drag-ghost"), null, { timeout: 5000 });
  }

  const errors = samples.map((sample) => ({
    x: Math.abs(sample.ghost.left + sample.ghost.width / 2 - sample.point.x),
    y: Math.abs(sample.ghost.top + sample.ghost.height / 2 - sample.point.y)
  }));
  const maxErrorX = Math.max(...errors.map((error) => error.x));
  const maxErrorY = Math.max(...errors.map((error) => error.y));
  const tolerance = Math.max(4, geometry.board.width * 0.012);
  assert(maxErrorX <= tolerance && maxErrorY <= tolerance,
    `${label}: ghost stopped tracking the pointer center (max error ${maxErrorX.toFixed(2)}px/${maxErrorY.toFixed(2)}px, tolerance ${tolerance.toFixed(2)}px): ${JSON.stringify(samples)}.`);
  return { label, board: Math.round(geometry.board.width), maxErrorX, maxErrorY, parent: samples.find((sample) => sample.ghost)?.parent || null };
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
    const results = [];

    await startPlay(page);
    results.push(await trackHeldDrag(page, "#coachBoard", "Play normal"));
    await setBoardScale(page, 82);
    await startPlay(page);
    results.push(await trackHeldDrag(page, "#coachBoard", "Play resized small"));
    await setBoardScale(page, 122);
    await startPlay(page);
    await enterFullscreen(page, "#coachBoard");
    results.push(await trackHeldDrag(page, "#coachBoard", "Play fullscreen"));
    await leaveFullscreen(page);

    await page.goto(`${baseUrl}/#puzzles`, { waitUntil: "domcontentloaded" });
    await waitForBoard(page, "#realPuzzleBoard");
    results.push(await trackHeldDrag(page, "#realPuzzleBoard", "Puzzle after route change"));
    await resizeViewport(page, "#realPuzzleBoard", 390, 600);
    results.push(await trackHeldDrag(page, "#realPuzzleBoard", "Puzzle resized small"));
    await enterFullscreen(page, "#realPuzzleBoard");
    results.push(await trackHeldDrag(page, "#realPuzzleBoard", "Puzzle fullscreen"));
    await leaveFullscreen(page);

    await context.close();
    process.stdout.write(`PASS drag ghost follow regression (${results.map((item) => `${item.label}:${item.board}px err=${Math.max(item.maxErrorX, item.maxErrorY).toFixed(1)}px`).join(", ")})\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
