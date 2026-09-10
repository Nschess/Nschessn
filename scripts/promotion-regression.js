/*
 * Focused browser coverage for the custom promotion picker.
 *
 * The picker probe is opt-in through ?e2ePromotion=1 and only records the
 * selected piece; it does not alter the production game or server paths.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4182;
const baseUrl = `http://127.0.0.1:${port}`;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function staticContract() {
  const app = read("assets/app.js");
  const css = read("assets/app.css");
  const positionBody = app.slice(app.indexOf("function positionPromotionPicker("), app.indexOf("function showPromotionPicker("));
  const pickerBody = app.slice(app.indexOf("function showPromotionPicker("), app.indexOf("function choosePromotion("));
  assert.doesNotMatch(pickerBody, /window\.prompt|window\.alert/, "Promotion picker must not use a native browser dialog.");
  assert.match(app, /const promotionChoices = Object\.freeze\(\[[\s\S]*?Queen[\s\S]*?Rook[\s\S]*?Bishop[\s\S]*?Knight/, "Promotion picker must expose all four promotion pieces.");
  assert.match(pickerBody, /renderPieceOnSquare\(option, \{ color, type \}, activePieceSvgSet, false\)/, "Promotion options must use the equipped piece renderer.");
  assert.match(pickerBody, /positionPromotionPicker\(state\)/, "Promotion picker must position itself from live board geometry.");
  assert.match(positionBody, /const candidates = \[[\s\S]*?placement: "right"[\s\S]*?placement: "left"[\s\S]*?placement: "below"[\s\S]*?placement: "above"/, "Promotion picker must adapt its direction near viewport edges.");
  assert.match(pickerBody, /document\.addEventListener\("keydown", state\.onDocumentKeyDown, true\)/, "Promotion picker must support keyboard cancellation.");
  assert.match(app, /function makeCoachMove\(from, to, promotionOverride = ""\)[\s\S]*?choosePromotion\(legalMoves, board, to,[\s\S]*?makeCoachMove\(from, to, choice\)/, "Play promotion must remain pending until a piece is selected.");
  assert.match(app, /if \(promotionPickerState\) return;/, "Board clicks must be ignored while promotion choice is pending.");
  assert.match(css, /\.promotion-picker\s*\{[\s\S]*?position:\s*fixed[\s\S]*?z-index:/, "Promotion picker must escape the board's clipped paint layer.");
  assert.match(css, /\.promotion-picker-option[\s\S]*?min-height:\s*48px/, "Promotion options must retain an accessible touch target.");
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const request = http.get(`${baseUrl}/`, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > 15000) reject(new Error("Promotion regression test server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function startPlayGame(page) {
  await page.locator("#aiBotRoster [data-ai-bot-play]").first().click();
  await page.locator("#aiGameReady").waitFor({ state: "visible" });
  await page.locator("#aiGameReadyStart").click();
  await page.waitForSelector("#coachBoard [data-square]");
}

async function readPicker(page) {
  return page.evaluate(() => {
    const picker = document.querySelector(".promotion-picker");
    const rect = picker?.getBoundingClientRect();
    return {
      visible: Boolean(picker && rect?.width && rect?.height),
      placement: picker?.dataset.placement || "",
      rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
      options: [...(picker?.querySelectorAll(".promotion-picker-option") || [])].map((option) => ({
        promotion: option.dataset.promotion,
        piece: option.querySelector("[data-piece]")?.dataset.piece || "",
        disabled: option.disabled,
        width: option.getBoundingClientRect().width,
        height: option.getBoundingClientRect().height
      }))
    };
  });
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
    await installOfflineSupabaseFixture(context);
    const page = await context.newPage();
    let dialogSeen = false;
    page.on("dialog", (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });
    await page.goto(`${baseUrl}/?e2ePromotion=1#bots`, { waitUntil: "domcontentloaded" });
    await startPlayGame(page);
    assert.equal(await page.evaluate(() => typeof window.__nschessPromotionTest?.open), "function", "Promotion probe was not installed.");

    await page.evaluate(() => window.__nschessPromotionTest.open({ color: "w", destination: "a8" }));
    let picker = await readPicker(page);
    assert(picker.visible, "White promotion picker did not open.");
    assert.equal(picker.options.length, 4, "White promotion picker must have four options.");
    assert.deepEqual(picker.options.map((option) => option.piece), ["wq", "wr", "wb", "wn"], "White picker must render the equipped white pieces.");
    assert(picker.rect.left >= 0 && picker.rect.top >= 0 && picker.rect.right <= 390 && picker.rect.bottom <= 844,
      `White picker escaped the viewport: ${JSON.stringify(picker)}.`);

    // A board click while the picker is pending must not commit or select a
    // different move underneath the isolated promotion decision.
    await page.locator('#coachBoard [data-square="a7"]').click();
    assert.equal(await page.evaluate(() => window.__nschessPromotionTest.lastChoice), "", "Board click changed a pending promotion decision.");
    await page.locator('.promotion-picker-option[data-promotion="r"]').click();
    assert.equal(await page.evaluate(() => window.__nschessPromotionTest.lastChoice), "r", "Mouse selection did not choose rook promotion.");
    assert.equal(await page.locator(".promotion-picker").count(), 0, "Picker remained open after mouse selection.");

    for (const choice of ["q", "b"]) {
      await page.evaluate(() => window.__nschessPromotionTest.open({ color: "w", destination: "a8" }));
      await page.locator(`.promotion-picker-option[data-promotion="${choice}"]`).tap();
      assert.equal(await page.evaluate(() => window.__nschessPromotionTest.lastChoice), choice, `Touch selection did not choose ${choice} promotion.`);
    }

    await page.evaluate(() => window.__nschessPromotionTest.open({ color: "b", destination: "h1" }));
    picker = await readPicker(page);
    assert(picker.visible, "Black promotion picker did not open.");
    assert.deepEqual(picker.options.map((option) => option.piece), ["bq", "br", "bb", "bn"], "Black picker must render the equipped black pieces.");
    assert(picker.rect.left >= 0 && picker.rect.top >= 0 && picker.rect.right <= 390 && picker.rect.bottom <= 844,
      `Black edge picker escaped the viewport: ${JSON.stringify(picker)}.`);
    assert(["left", "above", "below", "right"].includes(picker.placement), "Black picker did not report an edge-aware placement.");
    await page.locator('.promotion-picker-option[data-promotion="n"]').focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.__nschessPromotionTest.lastChoice), "n", "Keyboard selection did not choose knight promotion.");
    assert.equal(dialogSeen, false, "Promotion flow opened a native browser dialog.");
    await context.close();
    console.log("PASS custom promotion picker: white/black pieces, all choices, edge fit, mouse, keyboard, and no native dialog");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
