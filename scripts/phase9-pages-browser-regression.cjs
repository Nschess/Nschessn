#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const pageUrl = `${pathToFileURL(path.join(root, "index.html")).href}#settings`;
const routes = ["settings", "store", "leaderboards", "friends", "login"];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(8000);
    page.on("pageerror", (error) => { throw error; });
    await page.route("**/*", (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (protocol === "http:" || protocol === "https:") return route.abort("blockedbyclient");
      return route.continue();
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const section = document.getElementById("settings");
      return section && getComputedStyle(section).display !== "none" && document.querySelector("#settingsTablist [role='tab']");
    }, null, { timeout: 15000 });

    for (const width of [1366, 980, 900, 390, 375, 320]) {
      await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
      await page.waitForFunction((expected) => document.querySelector("#settingsTablist")?.getAttribute("aria-orientation") === expected, width <= 980 ? "horizontal" : "vertical");
      const orientation = await page.locator("#settingsTablist").getAttribute("aria-orientation");
      assert.equal(orientation, width <= 980 ? "horizontal" : "vertical");
      const tabs = page.locator("#settingsTablist [role='tab']");
      assert.equal(await tabs.count(), 6);
      const initial = await page.evaluate(() => {
        const shell = document.getElementById("settingsShell");
        const tabs = [...shell.querySelectorAll("[role='tab']")];
        const active = [...shell.querySelectorAll("[role='tabpanel']")].filter((panel) => !panel.hidden);
        return {
          width: innerWidth,
          documentOverflow: document.documentElement.scrollWidth - innerWidth,
          settingsOverflow: shell.scrollWidth - shell.clientWidth,
          activeTabs: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length,
          activePanels: active.length,
          smallestTabHeight: Math.min(...tabs.map((tab) => tab.getBoundingClientRect().height))
        };
      });
      assert.ok(initial.documentOverflow <= 1, `${width}px Settings has document overflow: ${JSON.stringify(initial)}`);
      assert.ok(initial.settingsOverflow <= 1, `${width}px Settings shell overflows: ${JSON.stringify(initial)}`);
      assert.equal(initial.activeTabs, 1);
      assert.equal(initial.activePanels, 1);
      assert.ok(initial.smallestTabHeight >= 44, `${width}px Settings tab target is too small: ${initial.smallestTabHeight}`);
      console.log(`PASS Settings ${width}px: orientation=${orientation}, no horizontal overflow, 44px+ tabs.`);
    }

    console.log("CHECK Settings keyboard behavior.");
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.waitForFunction(() => document.querySelector("#settingsTablist")?.getAttribute("aria-orientation") === "vertical");
    await page.locator("#settingsTabAudio").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator("#settingsTabProfile").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#settingsPageProfile").isVisible(), true);
    assert.equal(await page.locator("#settingsTabProfile").evaluate((tab) => document.activeElement === tab), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#settingsTablist")?.getAttribute("aria-orientation") === "horizontal");
    await page.locator("#settingsTabProfile").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#settingsTabGameplay").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#settingsTabNotifications").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#settingsTabAudio").getAttribute("aria-selected"), "true", "mobile tab navigation wraps at the end");
    await page.keyboard.press("Home");
    assert.equal(await page.locator("#settingsTabAudio").getAttribute("aria-selected"), "true");
    console.log("PASS Settings keyboard tabs: desktop vertical, mobile horizontal, focus follows selection, Home/End and wrap work.");

    console.log("CHECK Settings persistence and reset.");
    await page.locator("#settingsTabGameplay").click();
    await page.locator('[data-pref-setting="contrast"]').selectOption("high");
    assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("high-contrast")), true);
    await page.locator("#settingsTabAudio").click();
    await page.locator("#settingsResetAudio").click();
    assert.equal(await page.locator('[data-audio-setting="master"]').inputValue(), "70");
    assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("high-contrast")), true, "Reset Audio must not reset gameplay preferences");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#settingsTablist [role='tab']"));
    assert.equal(await page.locator('[data-pref-setting="contrast"]').inputValue(), "high", "local Settings preference persists after reload");
    assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("high-contrast")), true);
    console.log("PASS Settings persistence: contrast survives reload; Reset Audio restores sound only.");

    for (const route of routes.slice(1)) {
      for (const width of [1366, 980, 900, 390, 375, 320]) {
        await page.setViewportSize({ width, height: width > 760 ? 900 : 844 });
        await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
        await page.waitForFunction((id) => {
          const panel = document.getElementById(id);
          return panel && getComputedStyle(panel).display !== "none";
        }, route === "login" ? "login" : route, { timeout: 8000 });
        const metrics = await page.evaluate((id) => {
          const panel = document.getElementById(id);
          return {
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            panelWidth: panel.getBoundingClientRect().width
          };
        }, route);
        assert.ok(metrics.documentOverflow <= 1, `${route} ${width}px document overflow: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.panelOverflow <= 1, `${route} ${width}px panel overflow: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.panelWidth > 0, `${route} ${width}px panel was not rendered`);
        console.log(`PASS ${route} ${width}px: no horizontal overflow.`);
      }
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
