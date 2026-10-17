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
  // A visible route shell is not proof its lazy controls have mounted. Wait
  // for the same controls we measure; retain all size/count assertions below.
  await page.waitForFunction((targets) => targets.some((selector) =>
    [...document.querySelectorAll(selector)].some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    })), selectors, { timeout: 12000 });
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
  const humanEntryMeasurements = await measureVisibleControls(page, "human Play entry", [
    "#humanPlayEntry .human-play-entry-option"
  ]);
  assert.equal(humanEntryMeasurements.length, 3,
    `human Play entry: expected Play Now, Play a Friend, and Challenge a Player, got ${JSON.stringify(humanEntryMeasurements)}.`);
  assert.equal(humanEntryMeasurements[0].text.includes("Play Now"), true,
    `human Play entry: Quick Match must remain the primary Play Now action, got ${JSON.stringify(humanEntryMeasurements[0])}.`);
  await assertNoHorizontalOverflow(page, "play");
  return humanEntryMeasurements;
}

async function checkBotPlayTouchTarget(page) {
  await waitForRoute(page, "bots");
  // Route visibility precedes the lazy roster render. Measure the real
  // mounted control, not the loading placeholder during concurrent QA runs.
  await page.locator('#aiBotRoster [data-ai-bot-play]:not(:disabled)').first().waitFor({ state: 'visible' });
  const measurements = await page.evaluate(() => [...document.querySelectorAll("#aiBotRoster [data-ai-bot-play]:not(:disabled)")]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    })
    .slice(0, 1)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { text: (element.innerText || "").trim().slice(0, 32), width: rect.width, height: rect.height };
    }));
  assert.equal(measurements.length, 1, "bots: expected one visible enabled Bot Play control for frozen-debt reporting.");
  const undersized = measurements.filter(({ width, height }) => width < 43.5 || height < 43.5);
  assert.equal(undersized.length, 0,
    `bots: Bot Play control must meet the 44px touch target: ${JSON.stringify(undersized)}.`);
  await assertNoHorizontalOverflow(page, "bots");
  return measurements;
}

async function checkDialogKeyboardBehavior(page) {
  const searchOpen = page.locator("#siteSearchOpen");
  await searchOpen.focus();
  await searchOpen.press("Enter");
  const dialog = page.locator("#siteSearchDialog");
  await page.waitForFunction(() => {
    const node = document.getElementById("siteSearchDialog");
    return Boolean(node && !node.hidden && getComputedStyle(node).display !== "none");
  }, null, { timeout: 3000 });
  const input = page.locator("#siteSearchInput");
  await page.waitForFunction(() => document.activeElement?.id === "siteSearchInput", null, { timeout: 3000 });
  assert.equal(await input.evaluate((element) => document.activeElement === element), true,
    "search dialog should move focus to its input.");
  const focusables = dialog.locator("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
  const count = await focusables.count();
  assert(count >= 2, "search dialog should expose a close control and input.");
  await focusables.first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(() => {
    const items = document.querySelector("#siteSearchDialog").querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    );
    return document.activeElement === items[items.length - 1];
  }, null, { timeout: 3000 });
  assert.equal(await focusables.nth(count - 1).evaluate((element) => document.activeElement === element), true,
    "Shift+Tab at the first search control should wrap inside the dialog.");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.getAttribute("hidden"), "", "Escape should close the search dialog.");
  await searchOpen.focus();
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await installOfflineSupabaseFixture(context);
  await installOptionalCdnFixtures(context);
  const page = await context.newPage();
  try {
    const results = { viewport: `${viewport.width}x${viewport.height}`, controls: 0 };
    if (viewport.width <= 768) {
      await waitForRoute(page, "top");
      // Exercise the first-visit dialog normally before testing the header;
      // its delayed opening must not compete with the search focus fixture.
      await page.locator("#firstVisitSetup").waitFor({ state: "visible", timeout: 3000 });
      await page.locator("#firstVisitSetupLater").click();
      const homeControls = await measureVisibleControls(page, "Home navigation", [
        ".site-header .brand", ".nav-utilities > a", ".nav-utilities > button", ".nav-mobile-menu > summary"
      ]);
      results.controls += homeControls.length;
      await assertNoHorizontalOverflow(page, "Home navigation");
      if (viewport.width <= 390) assert.equal(await page.evaluate(() => {
        const mark = document.querySelector(".site-header .brand-mark").getBoundingClientRect();
        return mark.width >= 30 && getComputedStyle(document.querySelector(".site-header .brand-copy")).display === "none";
      }), true, "The compact Home brand must show an unclipped logo, not squeezed brand text");
      assert.equal(await page.evaluate(() => [...document.querySelectorAll(
        ".site-header .brand, .nav-utilities > a, .nav-utilities > button, .nav-mobile-menu > summary"
      )].filter((node) => node.getBoundingClientRect().width).every((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })), true, "Home navigation controls must not be covered by another element");
      await checkDialogKeyboardBehavior(page);
      const menu = page.locator(".nav-mobile-menu > summary");
      await menu.focus();
      await menu.press("Enter");
      assert.notEqual(await page.locator(".nav-mobile-menu").getAttribute("open"), null);
      const storeLink = page.locator('.nav-mobile-panel [data-site-tab="store"]').first();
      await storeLink.focus();
      await storeLink.press("Enter");
      await page.waitForFunction(() => location.hash === "#store");
      const brand = page.locator(".site-header .brand");
      await brand.focus();
      await brand.press("Enter");
      await page.waitForFunction(() => !document.body.classList.contains("site-tab-mode"));
    }
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
    await checkBotPlayTouchTarget(page);
    if (viewport.width <= 390) await checkDialogKeyboardBehavior(page);
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
      { width: 390, height: 844 },
      { width: 375, height: 844 },
      { width: 320, height: 844 }
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
