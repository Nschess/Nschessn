/*
 * Review fullscreen regression.
 *
 * This deliberately uses the real post-game Review route and the shared
 * fullscreen control. It protects the contract that Review owns one usable
 * fullscreen workspace: board, evaluation context, and replay controls.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4197;
const baseUrl = `http://127.0.0.1:${port}`;
const reviewFixtureUserId = "00000000-0000-4000-8000-000000000001";
const reviewEngineMode = process.env.REVIEW_ENGINE === "available" ? "available" : "unavailable";

// Native fullscreen can expose a never-settling promise in restricted
// headless Chromium.  Do not return that promise through Playwright; the
// following state assertion remains the source of truth for test success.
async function requestExitFullscreen(page) {
  await page.evaluate(() => {
    if (!document.fullscreenElement || typeof document.exitFullscreen !== "function") return;
    try { void document.exitFullscreen(); } catch {}
  }).catch(() => {});
}

function installAuthenticatedReviewFixture(context) {
  return context.addInitScript({ content: `
    (() => {
      const user = {
        id: ${JSON.stringify(reviewFixtureUserId)},
        email: "review-regression@example.invalid",
        created_at: "2026-01-01T00:00:00.000Z",
        user_metadata: { username: "ReviewRegression" }
      };
      const session = {
        access_token: "review-regression-access-token",
        refresh_token: "review-regression-refresh-token",
        user
      };
      const isEnabled = () => localStorage.getItem("reviewRegressionAuth") === "1";
      const unavailable = () => ({ data: null, error: { code: "E2E_SUPABASE_OFFLINE", message: "Supabase is intentionally unavailable in this deterministic test." } });
      window.supabase = {
        createClient: () => ({
          auth: {
            getSession: async () => ({ data: { session: isEnabled() ? session : null }, error: null }),
            getUser: async () => ({ data: { user: isEnabled() ? user : null }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } }, error: null }),
            signOut: async () => ({ data: null, error: null }),
            startAutoRefresh() {},
            stopAutoRefresh() {}
          },
          rpc: async () => unavailable(),
          from: () => ({ select: async () => ({ data: [], error: null }) }),
          channel: () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() {} }),
          removeChannel() {}
        })
      };
    })();
  ` });
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
      if (Date.now() - started > 15000) reject(new Error("Review fullscreen regression server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function openReview(page) {
  await page.goto(`${baseUrl}/#bots`, { waitUntil: "domcontentloaded" });
  await page.locator("#aiBotRoster [data-ai-bot-play]").first().click();
  await page.locator("#aiGameReadyStart").click();
  await page.waitForFunction(() => document.querySelectorAll("#coachBoard [data-square]").length === 64, null, { timeout: 15000 });
  await page.locator('#coachBoard [data-square][draggable="true"]').first().click();
  await page.locator("#coachBoard [data-square].legal").first().click();
  await page.waitForFunction(() => {
    const row = document.querySelector("#moveHistory .move-pair");
    const moves = row ? [...row.querySelectorAll("span")].map((node) => node.textContent.trim()).filter(Boolean) : [];
    return moves.length >= 2;
  }, null, { timeout: 15000 });
  await page.locator("#resignGame").click();
  await page.locator("#resignConfirmButton").click();
  const analysisStartedAt = Date.now();
  await page.locator("#postGameDecisionReview").click();
  await page.waitForFunction(() => {
    const review = document.getElementById("gameReview");
    const workspace = document.getElementById("gameReviewWorkspace");
    return review?.classList.contains("is-review-page") && workspace && !workspace.hidden;
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#reviewBoardSlot [data-square]").length === 64, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const panel = document.getElementById("premiumReview");
    return panel && !panel.classList.contains("review-state-loading") && !panel.hasAttribute("aria-busy");
  }, null, { timeout: 20000 });
  const fallback = await page.evaluate(() => ({
    eval: document.getElementById("reviewEvalBadge")?.textContent || "",
    accuracy: document.getElementById("reviewPlayerAccuracy")?.textContent || "",
    coverage: document.getElementById("reviewAccuracyBadge")?.textContent || "",
    confidence: document.getElementById("reviewEngineConfidence")?.textContent || "",
    score: document.getElementById("reviewCenterEval")?.textContent || "",
    playerScoreRing: {
      meter: document.getElementById("reviewPlayerScoreRing")?.style.getPropertyValue("--review-score") || "",
      label: document.getElementById("reviewPlayerScoreRing")?.getAttribute("aria-label") || ""
    },
    rail: {
      hidden: document.getElementById("reviewEvalRail")?.hidden ?? true,
      available: document.getElementById("reviewEvalRail")?.dataset.evaluationAvailable || "",
      score: document.getElementById("reviewEvalScore")?.textContent || "",
      label: document.getElementById("reviewEvalRail")?.getAttribute("aria-label") || ""
    },
    momentHeading: document.querySelector("#reviewOneMoment .review-one-moment-copy > span")?.textContent || "",
    momentCopy: document.getElementById("reviewOneMomentCopy")?.textContent || "",
    keyMoments: [...document.querySelectorAll("#reviewKeyMoments .review-key-content strong")].map((node) => node.textContent || "")
  }));
  assert.equal(fallback.playerScoreRing.meter.trim(), "0%",
    `CP loss must not be visualized as a percentage score: ${JSON.stringify(fallback.playerScoreRing)}.`);
  assert.match(fallback.playerScoreRing.label, /average centipawn loss/i);
  if (reviewEngineMode === "available") {
    assert.match(fallback.coverage, /Engine checks [1-9]\d*\//,
      `Locally available Stockfish must produce at least one verified move: ${JSON.stringify(fallback)}.`);
    assert.doesNotMatch(fallback.confidence, /no moves fully engine-verified/);
  } else {
    assert.match(fallback.eval, /Engine score unavailable|Mate score/);
    assert.equal(fallback.accuracy, "—", `Unavailable engine must not show fabricated CP loss: ${JSON.stringify(fallback)}.`);
    assert.match(fallback.coverage, /Engine checks 0\//);
    assert.doesNotMatch(fallback.coverage, /%/);
    assert.match(fallback.confidence, /no moves fully engine-verified/);
    assert.doesNotMatch(fallback.score, /^[-+]?0\.00$/);
    assert.equal(fallback.rail.hidden, false);
    assert.equal(fallback.rail.available, "false");
    assert.equal(fallback.rail.score, "—");
    assert.match(fallback.rail.label, /no position balance is inferred/);
    assert.match(fallback.momentHeading, /Practice candidate · not engine-rated/);
    assert.match(fallback.momentCopy, /not an engine verdict/);
    assert(!fallback.keyMoments.includes("Best"), `No-engine Review cannot identify a best move: ${JSON.stringify(fallback)}.`);
  }
  await page.waitForTimeout(180);
  const coverageMatch = fallback.coverage.match(/Engine checks (\d+)\/(\d+)/);
  return {
    reviewReadyMs: Date.now() - analysisStartedAt,
    engineCheckedMoves: Number(coverageMatch?.[1] || 0),
    totalMoves: Number(coverageMatch?.[2] || 0)
  };
}

async function readReviewState(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect?.();
      return box ? {
        x: box.x,
        y: box.y,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      } : null;
    };
    const board = document.querySelector("#reviewBoardSlot [data-interactive-board]");
    const stage = document.querySelector("#reviewBoardSlot [data-interactive-board-stage]");
    const boardWrap = document.querySelector("#reviewBoardSlot > .play-board-wrap");
    const slot = document.getElementById("reviewBoardSlot");
    const analysis = document.querySelector(".game-review-command-center > .game-review-analysis-slot");
    const rail = boardWrap?.querySelector(":scope > .review-eval-rail");
    const host = document.fullscreenElement;
    const current = document.querySelector(".game-review-current-column");
    const replay = document.querySelector("#reviewReplaySlot");
    const prev = document.getElementById("reviewPrev");
    const next = document.getElementById("reviewNext");
    const hostStyle = host ? getComputedStyle(host) : null;
    const scrollingElement = document.scrollingElement || document.documentElement;
    return {
      viewport: [window.innerWidth, window.innerHeight],
      board: rect(board),
      boardUnobscured: Boolean(board && [...board.querySelectorAll("[data-square]")].length === 64
        && [...board.querySelectorAll("[data-square]")].every((square) => {
          const box = square.getBoundingClientRect();
          return square.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })),
      stage: rect(stage),
      boardWrap: rect(boardWrap),
      slot: rect(slot),
      analysis: rect(analysis),
      rail: rect(rail),
      host: rect(host),
      current: rect(current),
      replay: rect(replay),
      prev: rect(prev),
      next: rect(next),
      fullscreenHost: host?.className || "",
      hostScrollWidth: host?.scrollWidth || 0,
      hostScrollHeight: host?.scrollHeight || 0,
      hostClientWidth: host?.clientWidth || 0,
      hostClientHeight: host?.clientHeight || 0,
      hostBoxSizing: hostStyle?.boxSizing || "",
      pageScrollWidth: scrollingElement.scrollWidth,
      pageScrollHeight: scrollingElement.scrollHeight,
      boardFullscreenSize: Number(stage?.dataset.boardFullscreenSize || 0),
      boardRequestedSize: Number(stage?.dataset.boardRequestedSize || 0),
      controlsAccessible: Boolean(prev && next && (!prev.disabled || !next.disabled)),
      previousDisabled: Boolean(prev?.disabled),
      nextDisabled: Boolean(next?.disabled),
      fullscreenButton: rect(stage?.querySelector("[data-board-fullscreen-action]"))
    };
  });
}

async function waitForNormalReviewGeometry(page) {
  await page.waitForFunction(() => {
    const board = document.querySelector("#reviewBoardSlot [data-interactive-board]")?.getBoundingClientRect();
    const stage = document.querySelector("#reviewBoardSlot [data-interactive-board-stage]")?.getBoundingClientRect();
    return board && stage && board.width > 100 && Math.abs(board.width - board.height) < 1
      && board.left >= stage.left && board.right <= stage.right + 1;
  }, null, { timeout: 5000 });
}

function assertVisible(rect, label, viewport) {
  assert(rect && rect.width > 0 && rect.height > 0, `${label} is not rendered: ${JSON.stringify(rect)}.`);
  assert(rect.x >= -1 && rect.y >= -1 && rect.right <= viewport[0] + 1 && rect.bottom <= viewport[1] + 1,
    `${label} is clipped by the viewport: ${JSON.stringify({ rect, viewport })}.`);
}

async function assertReviewControlAccessible(page, selector, label, viewport) {
  const control = page.locator(selector);
  await control.scrollIntoViewIfNeeded();
  const state = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scrollContainer = element.closest("#reviewReplaySlot");
    return {
      rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      scrollable: Boolean(scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight),
      pageScrollY: window.scrollY,
      pageScrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
      pageClientHeight: (document.scrollingElement || document.documentElement).clientHeight
    };
  });
  assert(state.scrollable, `${label} has no reachable fullscreen replay scroll container.`);
  assertVisible(state.rect, label, viewport);
  assert.equal(state.pageScrollY, 0, `${label} moved the document while becoming accessible: ${JSON.stringify(state)}.`);
  assert(state.pageScrollHeight <= state.pageClientHeight + 1,
    `${label} introduced document overflow while becoming accessible: ${JSON.stringify(state)}.`);
}

function requestedViewports() {
  const raw = String(process.env.REVIEW_VIEWPORT || "").trim();
  if (!raw) return [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [768, 1024], [624, 844], [390, 844], [375, 812], [320, 740]];
  const [width, height] = raw.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Invalid REVIEW_VIEWPORT: ${raw}`);
  return [[width, height]];
}

async function runCase(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  await context.route("https://**/*", (route) => route.abort());
  await installOptionalCdnFixtures(context);
  await context.route("**/api/auth-config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      url: "https://review-regression.invalid",
      anonKey: "review-regression-public-key",
      authRedirectOrigins: [baseUrl]
    })
  }));
  // Exercise unavailable-engine behavior deterministically by default. Set
  // REVIEW_ENGINE=available to use the checked-in local Stockfish worker.
  if (reviewEngineMode === "unavailable") {
    await context.route("**/assets/stockfish/**", (route) => route.abort("blockedbyclient"));
  }
  await installAuthenticatedReviewFixture(context);
  const page = await context.newPage();
  try {
    const reviewEvidence = await openReview(page);
    await waitForNormalReviewGeometry(page);
    const normal = await readReviewState(page);
    if (process.env.REVIEW_SCREENSHOTS === "1") {
      const directory = path.join(root, "e2e-artifacts", "phase10", "review");
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `normal-${width}.png`), animations: "disabled" });
    }
    assert(normal.board && Math.abs(normal.board.width - normal.board.height) < 1,
      `${width}x${height}: normal Review board is not square: ${JSON.stringify(normal)}.`);

    const fullscreenButton = page.locator("#reviewBoardSlot [data-board-fullscreen-action]");
    await fullscreenButton.waitFor({ state: "visible" });
    await fullscreenButton.click({ force: true });
    const fullscreenReady = () => page.waitForFunction(() => document.fullscreenElement?.matches(".game-review-command-center")
      && document.body.classList.contains("interactive-board-fullscreen-active"), null, { timeout: 5000 });
    try {
      await fullscreenReady();
    } catch (error) {
      // Chromium can reject the first native fullscreen activation while a
      // fresh context is settling. Retry the same visible user control once;
      // this does not change the application path or its assertions.
      await fullscreenButton.click({ force: true });
      await fullscreenReady().catch(() => { throw error; });
    }
    await page.waitForTimeout(250);

    const focused = await readReviewState(page);
    if (process.env.REVIEW_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(root, "e2e-artifacts", "phase10", "review", `fullscreen-${width}.png`), animations: "disabled" });
    }
    assert.equal(focused.fullscreenHost.includes("game-review-command-center"), true,
      `${width}x${height}: Review fullscreen did not promote the command center: ${JSON.stringify(focused)}.`);
    assert(focused.board && Math.abs(focused.board.width - focused.board.height) < 1,
      `${width}x${height}: fullscreen Review board is not square: ${JSON.stringify(focused)}.`);
    assertVisible(focused.board, `${width}x${height} fullscreen board; geometry=${JSON.stringify({ stage: focused.stage, boardWrap: focused.boardWrap, slot: focused.slot, analysis: focused.analysis, rail: focused.rail })}`, focused.viewport);
    assert(focused.board.y >= focused.analysis.y - 1 && focused.board.bottom <= focused.analysis.bottom + 1,
      `${width}x${height}: board is clipped by its analysis row: ${JSON.stringify(focused)}.`);
    assert.equal(focused.boardUnobscured, true,
      `${width}x${height}: all 64 square centers must be visible without scrolling another panel.`);
    assertVisible(focused.current, `${width}x${height} Review evaluation context`, focused.viewport);
    assertVisible(focused.replay, `${width}x${height} Review replay controls`, focused.viewport);
    assert.equal(focused.controlsAccessible, true,
      `${width}x${height}: no adjacent Review move is available: ${JSON.stringify(focused)}.`);
    // On compact touch viewports the replay dock is intentionally scrollable so
    // the full control set remains available without shrinking the board or
    // making the fullscreen document scroll. Prove the controls are reachable
    // through that dock rather than requiring every button to be visible at
    // once in the initial composition.
    await assertReviewControlAccessible(page, "#reviewPrev", `${width}x${height} Review previous control`, focused.viewport);
    assert(focused.fullscreenButton && focused.fullscreenButton.width > 0,
      `${width}x${height}: Review fullscreen control disappeared in focus mode: ${JSON.stringify(focused)}.`);
    assert(focused.fullscreenButton.width >= 44 && focused.fullscreenButton.height >= 44,
      `${width}x${height}: exit focus must retain a 44px touch target.`);
    assertVisible(focused.fullscreenButton, `${width}x${height} exit focus control`, focused.viewport);
    assert(focused.fullscreenButton.x >= focused.board.right || focused.fullscreenButton.y >= focused.board.bottom,
      `${width}x${height}: exit focus must not cover playable squares.`);
    assert.equal(await fullscreenButton.getAttribute("aria-label"), "Exit focus mode");
    assert.equal(focused.hostBoxSizing, "border-box",
      `${width}x${height}: Review fullscreen host must use border-box sizing: ${JSON.stringify(focused)}.`);
    assert(focused.hostScrollWidth <= focused.hostClientWidth + 1 && focused.hostScrollHeight <= focused.hostClientHeight + 1,
      `${width}x${height}: Review fullscreen workspace scrolls internally: ${JSON.stringify(focused)}.`);
    assert(focused.pageScrollWidth <= focused.viewport[0] + 1 && focused.pageScrollHeight <= focused.viewport[1] + 1,
      `${width}x${height}: Review fullscreen introduced page overflow: ${JSON.stringify(focused)}.`);
    assert(focused.boardFullscreenSize > 0, `${width}x${height}: Review fullscreen size was not measured.`);
    // The compact Review composition reserves the measured evaluation rail and
    // stage gutters before sizing the square board. On a 390px touch viewport
    // that safe square is 264px; assert against the rendered stage geometry,
    // not an arbitrary device-width threshold.
    const minimum = Math.max(240, focused.stage.width - 40);
    assert(focused.board.width >= minimum,
      `${width}x${height}: Review fullscreen board did not use the available workspace: ${JSON.stringify({ minimum, focused })}.`);

    // This fixture intentionally contains one legal move, so there is no
    // adjacent replay position for Prev/Next to visit. Exercise navigation
    // when the rendered Review timeline actually exposes multiple positions;
    // otherwise the fullscreen contract is the board/control workspace itself.
    const reviewMoveCount = await page.locator("#reviewCenterTimeline .review-timeline-item").count();
    if (reviewMoveCount > 1) {
      assert.equal(focused.previousDisabled, false, `${width}x${height}: previous move should be enabled at the end of the game.`);
      assert.equal(focused.nextDisabled, true, `${width}x${height}: next move should be disabled at the end of the game.`);
      const beforeMove = await page.locator("#coachBoard").innerHTML();
      await page.locator("#reviewPrev").click();
      await page.waitForFunction((previous) => document.getElementById("coachBoard")?.innerHTML !== previous, beforeMove, { timeout: 5000 });
      assert.equal(await page.locator("#reviewPrev").isDisabled(), true, `${width}x${height}: previous move should disable at the first ply.`);
      assert.equal(await page.locator("#reviewNext").isDisabled(), false, `${width}x${height}: next move should enable at the first ply.`);
      await assertReviewControlAccessible(page, "#reviewNext", `${width}x${height} Review next control`, focused.viewport);
      const afterPrevious = await page.locator("#coachBoard").innerHTML();
      await page.locator("#reviewNext").click();
      await page.waitForFunction((previous) => document.getElementById("coachBoard")?.innerHTML !== previous, afterPrevious, { timeout: 5000 });
      assert.equal(await page.locator("#reviewPrev").isDisabled(), false, `${width}x${height}: previous move should re-enable at the end.`);
      assert.equal(await page.locator("#reviewNext").isDisabled(), true, `${width}x${height}: next move should disable again at the end.`);
    }

    // A rectangle alone cannot prove usability: the real Exit focus action
    // must be reachable without force-clicking through another panel.
    await fullscreenButton.click({ timeout: 5000 });
    await page.waitForFunction((expected) => !document.fullscreenElement
      && !document.body.classList.contains("interactive-board-fullscreen-active")
      && Number(document.querySelector("#reviewBoardSlot [data-interactive-board-stage]")?.dataset.boardRequestedSize || 0) === expected,
    normal.boardRequestedSize, { timeout: 5000 });
    await waitForNormalReviewGeometry(page);
    await page.waitForFunction((expected) => Math.abs((document.querySelector("#reviewBoardSlot [data-interactive-board]")?.getBoundingClientRect().width || 0) - expected) < 2,
      normal.board.width, { timeout: 5000 });
    const restored = await readReviewState(page);
    assert(Math.abs((restored.board?.width || 0) - normal.board.width) < 2,
      `${width}x${height}: Review normal board size was not restored: ${JSON.stringify({ normal, restored })}.`);

    // Seed the documented account-owned saved Review contract with the real
    // legal move used above, then exercise the production route-recovery path
    // on refresh. This uses the same workspace snapshot that a signed-in
    // account uses; it does not bypass the Review route or fullscreen controller.
    await page.evaluate(() => {
      const key = "checkmateQuest.puzzles.v1";
      const state = JSON.parse(localStorage.getItem(key) || "{}");
      const review = {
        id: "review-e2e-refresh",
        date: new Date().toISOString(),
        pgn: "1. e4 e5 *",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        moves: [
          { ply: 1, moveNumber: 1, from: "e2", to: "e4", san: "e4", color: "w", piece: "p", phase: "Opening", label: "Unverified", engineVerified: false, cpLoss: null, tactic: "position awareness", explanation: "Engine unavailable.", fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" },
          { ply: 2, moveNumber: 1, from: "e7", to: "e5", san: "e5", color: "b", piece: "p", phase: "Opening", label: "Unverified", engineVerified: false, cpLoss: null, tactic: "position awareness", explanation: "Engine unavailable.", fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2" }
        ],
        analysis: { mode: "Quick engine", reviewModelVersion: 2, verifiedMoves: 0, totalMoves: 2, averageDepth: 0 },
        summary: { opening: "King's Pawn Game", turning: "1. e4", mvp: "e4", mistake: "No major mistake found.", chances: "One move to review.", result: "Game finished.", tip: "Keep using center, development, and king safety." }
      };
      state.matchReviews = [review, ...(Array.isArray(state.matchReviews) ? state.matchReviews : [])].slice(0, 12);
      localStorage.setItem(key, JSON.stringify(state));
      const workspaces = JSON.parse(localStorage.getItem("checkmateQuest.accountWorkspaces.v1") || "{}");
      workspaces.version = 1;
      workspaces.accounts = workspaces.accounts && typeof workspaces.accounts === "object" ? workspaces.accounts : {};
      workspaces.accounts["00000000-0000-4000-8000-000000000001"] = {
        updatedAt: new Date().toISOString(),
        values: { [key]: JSON.stringify(state) }
      };
      localStorage.setItem("checkmateQuest.accountWorkspaces.v1", JSON.stringify(workspaces));
      localStorage.setItem("checkmateQuest.accountWorkspaceOwner.v1", "00000000-0000-4000-8000-000000000001");
      localStorage.setItem("reviewRegressionAuth", "1");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => document.getElementById("gameReview")?.classList.contains("is-review-page")
        && document.querySelectorAll("#reviewBoardSlot [data-square]").length === 64, null, { timeout: 30000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        hash: window.location.hash,
        authState: document.documentElement.dataset.authState || "",
        reviewClass: document.getElementById("gameReview")?.className || "",
        reviewHidden: document.getElementById("gameReviewWorkspace")?.hidden ?? null,
        squares: document.querySelectorAll("#reviewBoardSlot [data-square]").length,
        owner: localStorage.getItem("checkmateQuest.accountWorkspaceOwner.v1"),
        workspace: localStorage.getItem("checkmateQuest.accountWorkspaces.v1"),
        puzzleState: localStorage.getItem("checkmateQuest.puzzles.v1")
      }));
      throw new Error(`${error.message} ${JSON.stringify(diagnostics)}`);
    }
    const refreshed = await readReviewState(page);
    assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false,
      `${width}x${height}: Review refresh unexpectedly retained fullscreen.`);
    assert(refreshed.board && Math.abs(refreshed.board.width - refreshed.board.height) < 1,
      `${width}x${height}: Review refresh lost square board geometry: ${JSON.stringify(refreshed)}.`);

    return `${width}x${height}:${Math.round(focused.board.width)}px, Review-ready=${reviewEvidence.reviewReadyMs}ms, engine checks=${reviewEvidence.engineCheckedMoves}/${reviewEvidence.totalMoves}`;
  } finally {
    if (await page.evaluate(() => Boolean(document.fullscreenElement)).catch(() => false)) await requestExitFullscreen(page);
    await context.close();
  }
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root,
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"]
  });
  let browser = null;
  try {
    const launchOptions = { headless: true };
    if (process.env.REVIEW_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.REVIEW_CHROMIUM_EXECUTABLE;
    browser = await chromium.launch(launchOptions);
    await waitForServer();
    const results = [];
    for (const [width, height] of requestedViewports()) {
      const result = await runCase(browser, width, height);
      results.push(result);
      process.stdout.write(`PASS Review viewport ${result}\n`);
    }
    process.stdout.write(`PASS Review fullscreen regression; engine=${reviewEngineMode} (${results.join(", ")})\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.exitCode === null) server.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
