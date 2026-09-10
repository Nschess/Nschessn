const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { parseEnvFile } = require("./e2e-config.cjs");
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require("./e2e-runtime-fixtures.cjs");

const root = path.resolve(__dirname, "..");
const port = 4179;
const baseUrl = `http://127.0.0.1:${port}`;
const e2eEnv = parseEnvFile(path.join(root, ".env.e2e"));
const focusedOnly = process.argv.includes("--focused");

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
      if (Date.now() - started > 15000) reject(new Error("Accessibility regression test server did not start."));
      else setTimeout(check, 50);
    };
    check();
  });
}

async function waitForRoute(page, route) {
  await page.goto(`${baseUrl}/#${route}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction((id) => {
      const section = document.getElementById(id);
      if (!section || section.hidden || getComputedStyle(section).display === "none") return false;
      const rect = section.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, route, { timeout: 12000 });
  } catch (error) {
    const probe = await page.evaluate((id) => {
      const section = document.getElementById(id);
      const rect = section?.getBoundingClientRect();
      const style = section ? getComputedStyle(section) : null;
      return {
        route: id,
        url: location.href,
        viewport: [innerWidth, innerHeight],
        exists: Boolean(section),
        hidden: section?.hidden ?? null,
        display: style?.display || "",
        rect: rect ? [rect.width, rect.height] : null,
        activePanel: document.querySelector("main > .is-active-panel")?.id || ""
      };
    }, route);
    throw new Error(`Route readiness timed out: ${JSON.stringify(probe)}`, { cause: error });
  }
  await page.waitForTimeout(180);
}

async function measureVisibleControls(page, route, selectors) {
  const measurements = await page.evaluate(({ route: routeName, selectors: targets }) => targets.flatMap((selector) => {
    return [...document.querySelectorAll(selector)]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          route: routeName,
          selector,
          tag: element.tagName,
          text: (element.innerText || element.value || "").trim().slice(0, 32),
          width: rect.width,
          height: rect.height
        };
      });
  }), { route, selectors });

  assert(measurements.length > 0, `${route}: no visible controls matched ${selectors.join(", ")}.`);
  const undersized = measurements.filter(({ width, height }) => width < 43.5 || height < 43.5);
  assert.equal(undersized.length, 0,
    `${route}: essential control below the 44px target: ${JSON.stringify(undersized)}.`);
  return measurements;
}

async function assertNoHorizontalOverflow(page, route) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert(geometry.scrollWidth <= geometry.viewport + 2,
    `${route}: horizontal overflow detected: ${JSON.stringify(geometry)}.`);
}

async function checkRoute(page, route, selectors) {
  await waitForRoute(page, route);
  const measurements = await measureVisibleControls(page, route, selectors);
  await assertNoHorizontalOverflow(page, route);
  return measurements;
}

async function checkPlay(page) {
  await waitForRoute(page, "play");
  const library = page.locator("#play .coach-library");
  await library.evaluate((element) => { element.open = true; });
  const bot = page.locator("#play .coach-library .beginner-bot-card:not(:disabled)").first();
  await bot.waitFor({ state: "visible" });
  const botMeasurements = await measureVisibleControls(page, "play bot library", [
    "#play .coach-library .beginner-bot-card:not(:disabled)"
  ]);
  await bot.click();
  const lobbyStart = page.locator("#playLobbyStart");
  await lobbyStart.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.getElementById("playLobbyStart");
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await lobbyStart.click();
  await page.locator("#aiGameReady").waitFor({ state: "visible" });
  await page.locator("#aiGameReadyStart").click();
  await page.waitForFunction(() => {
    const board = document.querySelector("#coachBoard");
    return board?.querySelectorAll("[data-square]").length === 64
      && [...board.querySelectorAll("[data-square]")].some((square) => square.draggable);
  }, null, { timeout: 12000 });
  await page.locator("#resignGame").click();
  await page.locator("#resignConfirmDialog").waitFor({ state: "visible" });
  await page.locator("#resignConfirmCancel").click();
  await page.locator("#resignConfirmDialog").waitFor({ state: "hidden" });
  const compactPlayLayout = await page.evaluate(() => {
    const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? 0;
    const viewport = document.documentElement.clientWidth;
    const dock = document.querySelector(".mobile-bottom-nav");
    return {
      viewport,
      modeTop: top("#play .play-left-sidebar"),
      boardTop: top("#play .match-board-column"),
      dockDisplay: dock ? getComputedStyle(dock).display : "none"
    };
  });
  if (compactPlayLayout.viewport <= 860) {
    assert(compactPlayLayout.boardTop < compactPlayLayout.modeTop,
      `play: compact active-game board must precede secondary mode controls: ${JSON.stringify(compactPlayLayout)}.`);
    assert.equal(compactPlayLayout.dockDisplay, "none",
      `play: mobile bottom navigation must yield to the board: ${JSON.stringify(compactPlayLayout)}.`);
  }
  await assertNoHorizontalOverflow(page, "play");
  return botMeasurements;
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await installOfflineSupabaseFixture(context);
  await installOptionalCdnFixtures(context);
  const page = await context.newPage();
  try {
    const results = { viewport: `${viewport.width}x${viewport.height}`, controls: 0 };
    const loginSelectors = [
      "#login .login-form input",
      "#login .login-form select",
      "#login .login-actions .button"
    ];
    if (!focusedOnly) loginSelectors.push("#login .profile-optional-detail > summary");
    const loginMeasurements = await checkRoute(page, "login", loginSelectors);
    assert.equal(loginMeasurements.filter(({ selector }) => selector !== "#login .profile-optional-detail > summary").length, 5,
      `login: expected the five confirmed Profile/Player Pass controls, got ${JSON.stringify(loginMeasurements)}.`);
    results.controls += loginMeasurements.length;
    results.controls += (await checkPlay(page)).length;
    if (focusedOnly) return results;
    const puzzleMeasurements = await checkRoute(page, "puzzles", [
      "#puzzles :is(.real-puzzle-modes, .real-puzzle-difficulties) .mission-button",
      "#puzzles .real-puzzle-card[for=\"realPuzzleSelect\"] select",
      "#puzzles .real-puzzle-actions .button"
    ]);
    const puzzleSelectMeasurement = puzzleMeasurements.find(({ selector }) => selector.includes("realPuzzleSelect"));
    assert.ok(puzzleSelectMeasurement && puzzleSelectMeasurement.width >= 43.5 && puzzleSelectMeasurement.height >= 43.5,
      `puzzles: #realPuzzleSelect must be at least 44x44px, got ${JSON.stringify(puzzleSelectMeasurement)}.`);
    results.controls += puzzleMeasurements.length;
    results.controls += (await checkRoute(page, "tutorial", ["#tutorial .tutorial-actions .button"])).length;
    results.controls += (await checkRoute(page, "adventures", [
      "#adventureWorldTabs .boss-world-tab",
      "#adventureBossBattles .boss-card > .button",
      "#storyMap .story-node"
    ])).length;
    const openingMeasurements = await checkRoute(page, "openings", [
      "#openingExplorerSearch",
      "#openings .opening-explorer-mode",
      "#openingExplorerFavorite",
      "#openings .opening-explorer-controls .button"
    ]);
    assert.equal(openingMeasurements.length, 8,
      `openings: expected the eight confirmed Explorer controls, got ${JSON.stringify(openingMeasurements)}.`);
    results.controls += openingMeasurements.length;
    results.controls += (await checkRoute(page, "settings", [
      "#settingsShell .settings-tab",
      "#settingsShell select",
      "#settingsShell .settings-actions .button"
    ])).length;
    return results;
  } finally {
    await context.close();
  }
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
    const results = [];
    for (const viewport of [
      { width: 1366, height: 900 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 }
    ]) {
      results.push(await runViewport(browser, viewport));
    }
    process.stdout.write(`PASS accessibility ${focusedOnly ? "focused touch-target" : "touch-target"} regression ${JSON.stringify(results)}\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
