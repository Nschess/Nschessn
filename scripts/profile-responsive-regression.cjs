#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const pageUrl = `${pathToFileURL(path.join(root, "index.html")).href}#login`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await page.route("**/*", (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (protocol === "http:" || protocol === "https:") return route.abort("blockedbyclient");
      return route.continue();
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const login = document.getElementById("login");
      return login && getComputedStyle(login).display !== "none";
    }, null, { timeout: 10000 });

    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: width >= 760 ? 900 : 844 });
      await page.waitForTimeout(80);
      const result = await page.evaluate(() => {
        const login = document.getElementById("login");
        const profile = login?.querySelector(".login-player-profile");
        const rectOf = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        };
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
        };
        const statFields = Object.fromEntries(["gameRating", "gamesPlayed", "winRate", "puzzleRating", "puzzleAccuracy", "streak", "xp", "tokens"]
          .map((field) => [field, profile?.querySelector(`[data-profile-field="${field}"]`)?.textContent?.trim() || ""]));
        const accountFields = Object.fromEntries(["title", "xp", "streak", "puzzleRating", "gameRating", "achievements", "story", "stats", "joinDate", "lastLogin"]
          .map((field) => [field, login?.querySelector(`[data-account-field="${field}"]`)?.textContent?.trim() || ""]));
        const cardRects = [...(profile?.querySelectorAll(".profile-detail-section, .profile-stat-section, .profile-progress-section, .profile-enhancements") || [])]
          .filter(visible).map(rectOf);
        const summaries = [...(profile?.querySelectorAll("details > summary") || [])].filter(visible).map(rectOf);
        const dupIds = [...document.querySelectorAll("[id]")].map((element) => element.id)
          .filter((id, index, values) => values.indexOf(id) !== index);
        return {
          viewport: innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          login: login ? rectOf(login) : null,
          profile: profile ? rectOf(profile) : null,
          profileClientWidth: profile?.clientWidth || 0,
          profileScrollWidth: profile?.scrollWidth || 0,
          cardRects,
          summaries,
          statFields,
          accountFields,
          authState: document.documentElement.dataset.authState || "",
          duplicateIds: [...new Set(dupIds)]
        };
      });

      assert(result.profile, `${width}px: profile panel exists`);
      assert(result.profile.width > 0, `${width}px: profile panel is visible`);
      assert(result.profile.left >= -1 && result.profile.right <= width + 1,
        `${width}px: profile stays inside the viewport (${JSON.stringify(result.profile)})`);
      assert(result.profileScrollWidth <= result.profileClientWidth + 1,
        `${width}px: profile has no internal horizontal overflow (${result.profileScrollWidth}/${result.profileClientWidth})`);
      assert(result.cardRects.every((rect) => rect.left >= -1 && rect.right <= width + 1),
        `${width}px: profile cards stay in bounds (${JSON.stringify(result.cardRects)})`);
      assert(result.summaries.every((rect) => rect.height >= 40 && rect.left >= -1 && rect.right <= width + 1),
        `${width}px: profile disclosure controls remain readable and tappable (${JSON.stringify(result.summaries)})`);
      assert.deepEqual(result.duplicateIds, [], `${width}px: no duplicate DOM IDs`);
      assert(!/^(?:450 Elo|600 Elo|400)$/.test(result.statFields.gameRating)
        && result.statFields.gameRating === "—", `${width}px: guest rating is unavailable, not a fabricated default`);
      assert(result.statFields.winRate === "—", `${width}px: guest win rate is unavailable`);
      assert(result.statFields.puzzleRating === "—", `${width}px: guest practice score has no fabricated baseline`);
      assert(result.statFields.tokens === "—", `${width}px: guest profile does not imply an account wallet balance`);
      assert(result.statFields.xp === "—" && result.statFields.streak === "—",
        `${width}px: guest progress does not show fabricated XP or streak`);
      assert(result.accountFields.title === "—" && result.accountFields.joinDate === "—" && result.accountFields.lastLogin === "—",
        `${width}px: guest account details do not claim a saved title or dates`);
      console.log(`PASS ${width}px profile: no overflow, guest facts unavailable, disclosures usable (${result.authState || "pre-hydration"})`);
    }

    await page.setViewportSize({ width: 1366, height: 900 });
    const profileRowsBefore = await page.locator("#login [data-profile-achievements] .player-profile-achievement").count();
    const profileNodesBefore = await page.locator("#login .login-player-profile").evaluate((root) => root.querySelectorAll("*").length);
    const routeTo = async (hash, panelId) => {
      const destination = page.locator(`[data-site-tab="${panelId}"]`).first();
      await destination.click();
      await page.waitForFunction((id) => {
        const panel = document.getElementById(id);
        return panel && !panel.hidden && getComputedStyle(panel).display !== "none";
      }, panelId, { timeout: 8000 });
    };
    const routeTimes = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const startedAt = performance.now();
      await routeTo("#play", "play");
      await routeTo("#login", "login");
      routeTimes.push(Math.round(performance.now() - startedAt));
    }
    const profileRowsAfter = await page.locator("#login [data-profile-achievements] .player-profile-achievement").count();
    const profileNodesAfter = await page.locator("#login .login-player-profile").evaluate((root) => root.querySelectorAll("*").length);
    assert.equal(profileRowsAfter, profileRowsBefore, "repeated navigation must not accumulate profile achievement nodes");
    assert.equal(profileNodesAfter, profileNodesBefore, "repeated navigation must not accumulate Profile DOM nodes");
    assert.equal(await page.locator("#login").evaluate((panel) => panel.hidden), false, "return navigation restores the Profile route");
    console.log(`PASS repeated route navigation: 4 Play → Profile cycles, stable ${profileNodesAfter} Profile DOM nodes; local round-trip ms=${routeTimes.join(",")}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
