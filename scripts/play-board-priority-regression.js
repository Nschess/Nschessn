/*
 * Responsive Play workspace contract.
 *
 * This covers the normal active-game composition only. Focus mode remains
 * covered by board-sizing-regression.js and is intentionally not changed here.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOfflineSupabaseFixture } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4196;
const baseUrl = `http://127.0.0.1:${port}`;
const viewports = [
  [1920, 1080, 825],
  [1440, 900, 650],
  [1366, 768, 520],
  [1024, 768, 560],
  [768, 1024, 560],
  [624, 844, 460],
  [390, 844, 250]
];

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
      if (Date.now() - started > 15000) reject(new Error("Play layout regression server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function startActivePlay(page) {
  await page.goto(`${baseUrl}/#bots`, { waitUntil: "domcontentloaded" });
  await page.locator("#aiBotRoster [data-ai-bot-play]").first().click();
  await page.locator("#aiGameReady").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("aiGameReady")?.dataset.ready === "true", null, { timeout: 15000 });
  await page.locator("#aiGameReadyStart").click();
  await page.waitForFunction(() => document.querySelectorAll("#coachBoard [data-square]").length === 64, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const play = document.getElementById("play");
    const board = document.getElementById("coachBoard");
    const rect = board?.getBoundingClientRect?.();
    return play?.classList.contains("is-active-game")
      && play?.dataset.activeGameScrollAnchor === "ready"
      && rect && rect.width > 0 && rect.top >= -1;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(80);
}

async function readLayout(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect?.();
      return box ? { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const board = document.querySelector("#coachBoard");
    const stage = board?.closest("[data-interactive-board-stage]");
    const column = board?.closest(".match-board-column");
    const shell = board?.closest(".play-shell");
    const leftSidebar = shell?.querySelector(".play-left-sidebar");
    const rightSidebar = shell?.querySelector(".play-right-sidebar");
    const cards = [...(column?.querySelectorAll(":scope > .ai-player-card, :scope > .match-player-card") || [])];
    const square = board?.querySelector("[data-square]");
    const piece = board?.querySelector(".piece-svg, .piece-symbol, img");
    const discovery = document.querySelector("#play.is-active-game .interactive-board-discovery");
    const discoveryRect = rect(discovery);
    const fullscreenAction = [...document.querySelectorAll("#play.is-active-game [data-board-fullscreen-action]")]
      .find((action) => {
        const box = action.getBoundingClientRect?.();
        return Boolean(box && box.width > 0 && box.height > 0);
      }) || null;
    const fullscreenActionRect = rect(fullscreenAction);
    const restart = document.getElementById("restartGame");
    const directRailDrawers = [...document.querySelectorAll("#play.is-active-game .play-right-sidebar > details")];
    const overlap = Boolean(board && discoveryRect
      && discoveryRect.x < rect(board).right
      && discoveryRect.right > rect(board).x
      && discoveryRect.y < rect(board).bottom
      && discoveryRect.bottom > rect(board).y);
    const discoveryCardOverlap = Boolean(discoveryRect && cards.some((card) => card
      && discoveryRect.x < card.right
      && discoveryRect.right > card.x
      && discoveryRect.y < card.bottom
      && discoveryRect.bottom > card.y));
    const discoveryActionOverlap = Boolean(discoveryRect && fullscreenActionRect
      && discoveryRect.x < fullscreenActionRect.right
      && discoveryRect.right > fullscreenActionRect.x
      && discoveryRect.y < fullscreenActionRect.bottom
      && discoveryRect.bottom > fullscreenActionRect.y);
    const shellStyle = shell ? getComputedStyle(shell) : null;
    return {
      viewport: [window.innerWidth, window.innerHeight],
      board: rect(board),
      stage: rect(stage),
      column: rect(column),
      shell: rect(shell),
      leftSidebarDisplay: leftSidebar ? getComputedStyle(leftSidebar).display : "",
      rightSidebar: rect(rightSidebar),
      cards: cards.map(rect),
      piece: rect(piece),
      square: rect(square),
      gridAreas: shellStyle?.gridTemplateAreas || "",
      requested: Number(stage?.dataset.boardRequestedSize || 0),
      rendered: Number(stage?.dataset.boardRenderedSize || 0),
      manual: stage?.dataset.boardManualSize || "",
      centerTrackGutter: column && stage ? Math.max(0, column.getBoundingClientRect().width - stage.getBoundingClientRect().width) : null,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      fullscreen: Boolean(document.fullscreenElement),
      activeGameScrollAnchor: document.getElementById("play")?.dataset.activeGameScrollAnchor || "",
      discovery: discoveryRect,
      overlap,
      discoveryCardOverlap,
      discoveryActionOverlap,
      fullscreenAction: fullscreenActionRect,
      fullscreenActionTitle: fullscreenAction?.getAttribute("title") || "",
      fullscreenActionLabel: fullscreenAction?.getAttribute("aria-label") || "",
      restart: rect(restart),
      directRailDrawers: directRailDrawers.map((drawer) => ({ id: drawer.id, open: drawer.open }))
    };
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"]
  });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    await waitForServer();
    for (const [width, height, minimumBoard] of viewports) {
      const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
      try {
        await installOfflineSupabaseFixture(context);
        const page = await context.newPage();
        await startActivePlay(page);
        const layout = await readLayout(page);
        assert(layout.board && layout.stage && layout.column && layout.shell, `${width}x${height}: Play board geometry is missing.`);
        assert.equal(layout.activeGameScrollAnchor, "ready", `${width}x${height}: active game did not complete its board-workspace scroll anchor: ${JSON.stringify(layout)}.`);
        assert(Math.abs(layout.board.width - layout.board.height) < 1, `${width}x${height}: board is not square: ${JSON.stringify(layout)}.`);
        assert(layout.board.width >= minimumBoard, `${width}x${height}: default board is smaller than the board-first floor: ${JSON.stringify(layout)}.`);
        assert(layout.board.x >= -1 && layout.board.right <= width + 1, `${width}x${height}: board clips horizontally: ${JSON.stringify(layout)}.`);
        assert(layout.stage.width >= layout.board.width - 1, `${width}x${height}: board exceeds its stage: ${JSON.stringify(layout)}.`);
        if (width >= 1181) {
          assert(layout.centerTrackGutter <= 20,
            `${width}x${height}: desktop center track leaves an excessive board gutter: ${JSON.stringify(layout)}.`);
          assert.equal(layout.leftSidebarDisplay, "none",
            `${width}x${height}: active Play kept a competing permanent left rail: ${JSON.stringify(layout)}.`);
          assert(layout.rightSidebar && layout.rightSidebar.width >= 280 && layout.rightSidebar.width <= 326,
            `${width}x${height}: active Play contextual rail did not keep its compact 280–320px budget: ${JSON.stringify(layout)}.`);
          assert(layout.restart && layout.rightSidebar && layout.restart.width < layout.rightSidebar.width - 24,
            `${width}x${height}: Restart Game regained a full-width hero treatment: ${JSON.stringify(layout)}.`);
          assert(layout.directRailDrawers.every((drawer) => !drawer.open),
            `${width}x${height}: secondary active-game context opened by default: ${JSON.stringify(layout)}.`);
        }
        assert(layout.cards.length === 2 && layout.cards.every((card) => card && card.width > 0 && card.height > 0),
          `${width}x${height}: both player cards must remain rendered: ${JSON.stringify(layout)}.`);
        assert(layout.cards.every((card) => card.width <= width + 1), `${width}x${height}: player card exceeds viewport width: ${JSON.stringify(layout)}.`);
        if (width >= 1181) {
          assert(layout.cards.every((card) => card.y >= -1 && card.bottom <= height + 1),
            `${width}x${height}: desktop board sizing pushed a player card below the initial workspace viewport: ${JSON.stringify(layout)}.`);
        }
        assert(layout.piece && layout.square && layout.piece.width > 0 && layout.piece.height > 0,
          `${width}x${height}: board piece rendering disappeared: ${JSON.stringify(layout)}.`);
        assert(layout.piece.width <= layout.square.width + 1 && layout.piece.height <= layout.square.height + 1,
          `${width}x${height}: piece scaling escaped its square: ${JSON.stringify(layout)}.`);
        assert(layout.board.y >= -1 && layout.board.bottom <= height + 1,
          `${width}x${height}: active-game board was not initially visible: ${JSON.stringify(layout)}.`);
        assert.equal(layout.overlap, false,
          `${width}x${height}: resize discovery cue overlaps the board interaction surface: ${JSON.stringify(layout)}.`);
        assert.equal(layout.discoveryCardOverlap, false,
          `${width}x${height}: resize discovery cue overlaps a player card: ${JSON.stringify(layout)}.`);
        assert.equal(layout.discoveryActionOverlap, false,
          `${width}x${height}: resize discovery cue overlaps the fullscreen control: ${JSON.stringify(layout)}.`);
        if (width <= 900) {
          assert(layout.cards.every((card) => card.y >= -1 && card.bottom <= height + 1),
            `${width}x${height}: active-game player cards were left outside the initial viewport: ${JSON.stringify(layout)}.`);
        }
        assert.equal(layout.pageOverflow, false, `${width}x${height}: Play introduced horizontal overflow.`);
        assert.equal(layout.fullscreen, false, `${width}x${height}: normal layout unexpectedly entered fullscreen.`);
        assert(layout.fullscreenAction && layout.fullscreenAction.width > 0 && layout.fullscreenAction.height > 0,
          `${width}x${height}: active Play fullscreen control is not rendered: ${JSON.stringify(layout)}.`);
        assert.match(layout.fullscreenActionTitle, /Fullscreen/i,
          `${width}x${height}: active Play fullscreen control is missing its accessible tooltip: ${JSON.stringify(layout)}.`);
        assert.match(layout.fullscreenActionLabel, /Fullscreen/i,
          `${width}x${height}: active Play fullscreen control is missing its accessible label: ${JSON.stringify(layout)}.`);
        const fullscreenIsSeparated = width <= 700
          ? layout.fullscreenAction.y >= layout.board.bottom - 2 || layout.fullscreenAction.x >= layout.board.right - 2
          : layout.fullscreenAction.x >= layout.board.right - 2;
        assert(fullscreenIsSeparated,
          `${width}x${height}: fullscreen control overlaps the board surface: ${JSON.stringify(layout)}.`);
        assert.equal(layout.manual, "false", `${width}x${height}: fresh Play layout was incorrectly marked manual.`);
        if (width <= 900) {
          assert.match(layout.gridAreas, /^\s*"center"/, `${width}x${height}: active Play did not keep the board workspace in the first responsive track.`);
          assert.match(layout.gridAreas.trim(), /^"center"/,
            `${width}x${height}: secondary rails precede the board workspace: ${JSON.stringify(layout)}.`);
        }
        results.push(`${width}x${height}:${Math.round(layout.board.width)}px`);
      } finally {
        await context.close();
      }
    }
    await runInactiveHumanEntryRegression(browser);
    await runActiveContextAndFullscreenRegression(browser);
    console.log(`PASS Play board-priority responsive regression (${results.join(", ")})`);
  } finally {
    await browser.close();
    server.kill();
  }
}

async function runInactiveHumanEntryRegression(browser) {
  const results = [];
  for (const [width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    try {
      await installOfflineSupabaseFixture(context);
      const page = await context.newPage();

      await page.goto(`${baseUrl}/#play`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("humanPlayEntry") && getComputedStyle(document.getElementById("humanPlayEntry")).display !== "none");
      const humanEntry = await page.evaluate(() => ({
        entryVisible: getComputedStyle(document.getElementById("humanPlayEntry")).display !== "none",
        workspaceVisible: getComputedStyle(document.getElementById("playWorkspace")).display !== "none",
        options: [...document.querySelectorAll("#humanPlayEntry .human-play-entry-option")].map((option) => option.textContent.replace(/\s+/g, " ").trim()),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      }));
      assert.equal(humanEntry.entryVisible, true, `${width}x${height}: human Play entry is not visible.`);
      assert.equal(humanEntry.workspaceVisible, false, `${width}x${height}: inactive Play kept the AI workspace visible.`);
      assert.equal(humanEntry.options.length, 3, `${width}x${height}: human Play must keep exactly three primary choices.`);
      assert.match(humanEntry.options[0], /Quick Match\s*Play a random opponent/,
        `${width}x${height}: Quick Match copy changed unexpectedly.`);
      assert.match(humanEntry.options[1], /Play a Friend\s*Challenge someone you know/,
        `${width}x${height}: Play a Friend copy changed unexpectedly.`);
      assert.match(humanEntry.options[2], /Challenge a Player\s*Search registered players/,
        `${width}x${height}: Challenge a Player copy changed unexpectedly.`);
      assert.equal(humanEntry.overflow, false, `${width}x${height}: human Play entry introduced horizontal overflow.`);
      await page.locator("#humanPlayEntry .human-play-entry-option.is-primary").click();
      await page.locator("#quickMatchSetup").waitFor({ state: "visible" });
      await page.locator("#quickMatchSetupCancel").click();
      await page.locator("#quickMatchSetup").waitFor({ state: "hidden" });

      await page.goto(`${baseUrl}/#play?mode=friend`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.classList.contains("friend-challenge-mode")
        && getComputedStyle(document.getElementById("friendChallenge")).display !== "none");
      const friend = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect?.();
        return {
          workspaceVisible: getComputedStyle(document.getElementById("playWorkspace")).display !== "none",
          friendVisible: getComputedStyle(document.getElementById("friendChallenge")).display !== "none",
          detailsOpen: document.getElementById("friendMatchSettings")?.open,
          order: ["#friendList", ".friend-search-panel", "#friendMatchSettings", ".friend-share-card"].map((selector) => rect(selector)?.top ?? -1),
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1
        };
      });
      assert.equal(friend.friendVisible, true, `${width}x${height}: Friend workspace is not visible.`);
      assert.equal(friend.workspaceVisible, false, `${width}x${height}: Friend route rendered the inactive AI workspace.`);
      assert.equal(friend.detailsOpen, false, `${width}x${height}: Friend match details should begin collapsed.`);
      assert(friend.order.every((top) => top >= 0) && friend.order.every((top, index) => index === 0 || top > friend.order[index - 1]),
        `${width}x${height}: Friend workspace no longer follows people → search → details → share: ${JSON.stringify(friend)}.`);
      assert.equal(friend.overflow, false, `${width}x${height}: Friend workspace introduced horizontal overflow.`);

      await page.goto(`${baseUrl}/#play?mode=tournament`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.classList.contains("tournament-mode")
        && getComputedStyle(document.getElementById("tournamentLobby")).display !== "none");
      const tournament = await page.evaluate(() => ({
        workspaceVisible: getComputedStyle(document.getElementById("playWorkspace")).display !== "none",
        tournamentVisible: getComputedStyle(document.getElementById("tournamentLobby")).display !== "none",
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      }));
      assert.equal(tournament.tournamentVisible, true, `${width}x${height}: Tournament workspace is not visible.`);
      assert.equal(tournament.workspaceVisible, false, `${width}x${height}: Tournament route rendered the inactive AI workspace.`);
      assert.equal(tournament.overflow, false, `${width}x${height}: Tournament workspace introduced horizontal overflow.`);
      results.push(`${width}x${height}`);
    } finally {
      await context.close();
    }
  }
  console.log(`PASS human Play entry and special-lobby isolation (${results.join(", ")})`);
}

async function runActiveContextAndFullscreenRegression(browser) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    serviceWorkers: "block"
  });
  await installOfflineSupabaseFixture(context);
  const page = await context.newPage();
  try {
    await startActivePlay(page);
    const firstBot = (await page.locator("#aiPlayerName").textContent()).trim();

    // Create real position/history context, then finish through the
    // production resignation flow so recommendations are genuinely rendered.
    const playerSquare = page.locator('#coachBoard [data-square][draggable="true"]').first();
    await playerSquare.click();
    await page.locator("#coachBoard [data-square].legal").first().click();
    await page.waitForFunction(() => (document.getElementById("moveHistory")?.textContent || "").trim() !== "No moves yet.", null, { timeout: 10000 });
    await page.locator("#resignGame").click();
    await page.locator("#resignConfirmDialog").waitFor({ state: "visible" });
    await page.locator("#resignConfirmButton").click();
    await page.waitForFunction(() => {
      const links = document.getElementById("coachPracticeLinks");
      return links && !links.hidden && links.children.length > 0;
    }, null, { timeout: 10000 });

    // Dismiss the post-game decision layer, then exercise the actual Live
    // Match Restart Game control rather than bypassing the production path.
    await page.locator("#postGameDecisionClose").click();
    await page.locator("#restartGame").click();
    await page.waitForFunction(() => {
      const play = document.getElementById("play");
      const history = document.getElementById("moveHistory");
      const links = document.getElementById("coachPracticeLinks");
      const guided = document.getElementById("guidedReview");
      return play?.classList.contains("is-active-game")
        && history?.textContent.trim() === "No moves yet."
        && links?.hidden === true
        && links.children.length === 0
        && guided?.hidden === true
        && guided.querySelectorAll("#guidedReviewList > *").length === 0;
    }, null, { timeout: 10000 });

    const resetState = await page.evaluate(() => ({
      history: document.getElementById("moveHistory")?.textContent.trim(),
      practiceHidden: document.getElementById("coachPracticeLinks")?.hidden,
      practiceCount: document.getElementById("coachPracticeLinks")?.children.length,
      guidedHidden: document.getElementById("guidedReview")?.hidden,
      guidedCount: document.getElementById("guidedReviewList")?.children.length
    }));
    assert.deepEqual(resetState, {
      history: "No moves yet.",
      practiceHidden: true,
      practiceCount: 0,
      guidedHidden: true,
      guidedCount: 0
    }, `Restarted game retained position context: ${JSON.stringify(resetState)}.`);

    await page.locator("#coachToolsDrawer").evaluate((drawer) => { drawer.open = true; });
    await page.locator("#playKingNorbert").click();
    await page.waitForFunction((previous) => {
      const name = document.getElementById("aiPlayerName")?.textContent?.trim();
      return document.getElementById("play")?.classList.contains("is-active-game")
        && name && name !== previous
        && document.getElementById("aiPlayerRating")?.textContent?.includes("2000");
    }, firstBot, { timeout: 10000 });
    assert.notEqual((await page.locator("#aiPlayerName").textContent()).trim(), firstBot,
      "Selecting the second AI did not replace the previous opponent metadata.");

    const fullscreen = page.locator("#play.is-active-game [data-board-fullscreen-action]");
    await fullscreen.click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement)
      && document.fullscreenElement.matches(".match-board-column"), null, { timeout: 5000 });
    const focusState = await page.evaluate(() => {
      const board = document.getElementById("coachBoard")?.getBoundingClientRect();
      const opponent = document.getElementById("aiPlayerCard")?.getBoundingClientRect();
      const player = document.getElementById("matchPlayerCard")?.getBoundingClientRect();
      return {
        square: Boolean(board && Math.abs(board.width - board.height) < 1),
        boardVisible: Boolean(board && board.width > 0 && board.height > 0),
        cardsVisible: Boolean(opponent?.width && opponent?.height && player?.width && player?.height)
      };
    });
    assert(focusState.square && focusState.boardVisible && focusState.cardsVisible,
      `Existing Play fullscreen workspace lost board/card context: ${JSON.stringify(focusState)}.`);
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement
      && !document.body.classList.contains("interactive-board-fullscreen-active"), null, { timeout: 5000 });
  } finally {
    if (await page.evaluate(() => Boolean(document.fullscreenElement)).catch(() => false)) {
      await page.evaluate(() => document.exitFullscreen()).catch(() => {});
    }
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
