/* Static contracts for route isolation, compact navigation, and game safety. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("assets/app.js");
const css = read("assets/app.css");
const playCss = read("assets/play-lobby.css");
const html = read("index.html");

assert.match(app, /function showRouteFeatureFailure\(panel, featureName\)/, "Deferred route failures must have a visible recovery boundary.");
assert.match(app, /This section could not load\. Your saved work is safe\./, "Route failures must explain the safe recovery state without leaking internals.");
assert.match(app, /Route module \$\{name\} failed to load\.[\s\S]*?routeError: true/, "Route-module import failures must become visible recovery state instead of null.");
assert.match(app, /if \(module\?\.routeError\) showRouteFeatureFailure\(panelElement, `route:\$\{module\.routeName \|\| panel\}`\)/, "Route-module failures must render their retry boundary on the active panel.");
assert.match(app, /if \(ok === false\) showRouteFeatureFailure\(panelElement, name\)/, "Deferred initializer failures must surface on the active route.");
assert.match(app, /function syncOptionalRouteStylesheets\(styles = \[\]\)/, "Route CSS must have an active-route reconciliation path.");
assert.match(app, /link\.remove\(\);\s*optionalRouteStylesheetPromises\.delete\(key\);/, "Inactive route CSS must be removed with its cached loader promise.");
assert.match(app, /firstVisitSetupClose\?\.\(\{ restoreFocus: false \}\)/, "Home onboarding must close before changing routes.");
assert.match(app, /document\.body\.classList\.toggle\("is-board-route", \["play", "puzzles", "gameReview"\]\.includes\(config\.panel\)\)/, "Board-centric routes must own compact navigation state.");
assert.match(app, /function openResignConfirmation\(\)/, "Resign must require an explicit confirmation step.");
assert.match(app, /document\.getElementById\("resignConfirmButton"\)\?\.addEventListener/, "The resign confirmation action must be wired to a visible dialog.");
assert.match(html, /id="resignConfirmDialog"[\s\S]*?id="resignConfirmCancel"[\s\S]*?id="resignConfirmButton"/, "Resign confirmation dialog markup must include cancel and confirm actions.");
assert.match(css, /\.nav-mobile-menu:not\(\[open\]\) > \.nav-mobile-panel\s*\{\s*display: none !important;/, "Closed mobile menus must not paint their panel contents.");
assert.match(css, /\.ai-bot-grid\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); min-width: 0; width: 100%;/, "Compact bot grids must fit two columns without clipping.");
assert.match(css, /body\.is-board-route \.mobile-bottom-nav\s*\{\s*display: none !important;/, "The mobile dock must yield on board routes.");
const finalPlayOrder = css.lastIndexOf('grid-template-areas: "left" "center" "right" "social"');
assert.ok(finalPlayOrder >= 0, "The final compact Play contract must put mode selection before the board.");
assert.match(playCss, /@media \(max-width: 900px\)[\s\S]*?grid-template-areas: "left" "center" "right" !important;/, "Route-owned Play CSS must preserve the same compact reading order after lazy loading.");
assert.match(css, /#top \.hero-dashboard > #homeContinueAction\s*\{\s*display: none;/, "Home's duplicate quick action must stay hidden behind the focused session path.");
assert.match(css, /\.store-page\.is-guest-store \.store-gift-open/, "Guest Store empty state must hide account-only gifting controls.");
assert.match(css, /\.friends-empty-sign-in\s*\{/, "Friends empty state must offer one clear sign-in action.");
assert.match(css, /\.button\.danger[\s\S]*?background:/, "Destructive buttons must have a distinct visual hierarchy.");

console.log("PASS route interaction regression: route errors, CSS isolation, compact Play order, menu state, onboarding, empty states, and resign safety are covered.");
