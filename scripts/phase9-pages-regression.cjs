#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/\r\n/g, "\n");

function extractFunction(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(declaration, `production function ${name} exists`);
  const start = declaration.index;
  const paramsOpen = app.indexOf("(", declaration.index + declaration[0].length - 1);
  let paramsDepth = 0;
  let quote = "";
  let escapedParam = false;
  let paramsClose = -1;
  for (let i = paramsOpen; i < app.length; i += 1) {
    const ch = app[i];
    if (quote) {
      if (escapedParam) { escapedParam = false; continue; }
      if (ch === "\\") { escapedParam = true; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") paramsDepth += 1;
    if (ch === ")" && --paramsDepth === 0) { paramsClose = i; break; }
  }
  assert.notEqual(paramsClose, -1, `${name} parameters are balanced`);
  let bodyStart = paramsClose + 1;
  while (/\s/.test(app[bodyStart] || "")) bodyStart += 1;
  let open = bodyStart;
  assert.equal(app[open], "{", `${name} has a function body`);
  let depth = 0;
  let state = "code";
  let escaped = false;
  for (let i = open; i < app.length; i += 1) {
    const ch = app[i];
    const next = app[i + 1];
    if (state === "line") { if (ch === "\n") state = "code"; continue; }
    if (state === "block") { if (ch === "*" && next === "/") { state = "code"; i += 1; } continue; }
    if (state !== "code") {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) state = "code";
      continue;
    }
    if (ch === "/" && next === "/") { state = "line"; i += 1; continue; }
    if (ch === "/" && next === "*") { state = "block"; i += 1; continue; }
    if (ch === "'") { state = "single"; continue; }
    if (ch === '"') { state = "double"; continue; }
    if (ch === "`") { state = "template"; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`could not extract production function ${name}`);
}

function productionFunction(name, parameters = [], values = []) {
  return new Function(...parameters, `return (${extractFunction(name)});`)(...values);
}

function testLeaderboardDataTruthfulness() {
  const readMetric = productionFunction("readLeaderboardMetric");
  const getMetrics = productionFunction("getLeaderboardMetrics", ["readLeaderboardMetric"], [readMetric]);
  const build = productionFunction("buildLeaderboardEntries", [
    "isApplicationAuthenticated", "normalizeAuthUsername", "leaderboardRuntime", "readAuthRegistry", "readLearnerProfile",
    "filterLeaderboardAccounts", "getLeaderboardAccountId", "getLeaderboardMetrics", "formatProfileNumber", "formatCountryFlag"
  ], [
    () => true,
    (value) => String(value || ""),
    { status: "global", accounts: [
      { publicId: "game-only", username: "GameOnly", rating: 1240, statistics: { wins: 3, losses: 2, draws: 1 } },
      { publicId: "puzzle-rated", username: "PuzzleRated", puzzleRating: 1510, statistics: {} },
      { publicId: "puzzle-stats", username: "PuzzleStats", statistics: { puzzlesSolved: 12, puzzleAccuracy: 75 } },
      { publicId: "invalid", username: "Invalid", gameRating: true, puzzleRating: 3500, statistics: { wins: -1 } }
    ] },
    () => ({ accounts: [] }),
    () => ({ name: "Current" }),
    (accounts) => accounts,
    (account) => String(account.publicId || account.id || ""),
    getMetrics,
    (value) => Number(value).toLocaleString("en-US"),
    (value) => value || ""
  ]);

  assert.equal(getMetrics({ rating: 1250 }).gameRating, 1250);
  assert.equal(getMetrics({ rating: 1250 }).puzzleRating, null, "game Elo cannot become puzzle rating");
  assert.equal(getMetrics({ gameRating: true, puzzleRating: 3500 }).gameRating, null, "invalid ratings fail closed");
  assert.equal(getMetrics({ gameRating: 1100, statistics: { wins: 0, losses: 0, draws: 0 } }).winRate, null, "zero games has no fabricated win rate");
  assert.equal(getMetrics({ gameRating: 1100, statistics: { wins: -1 } }).wins, null, "negative counters are unavailable");

  const gameEntries = build("ai");
  assert.deepEqual(gameEntries.map((entry) => entry.id), ["game-only"]);
  assert.deepEqual(gameEntries[0].meta, ["3 wins", "6 games", "50% win rate"]);
  const puzzleEntries = build("puzzles");
  assert.deepEqual(puzzleEntries.map((entry) => entry.id), ["puzzle-rated", "puzzle-stats"]);
  assert.equal(puzzleEntries[0].primary, "1,510 rating");
  assert.deepEqual(puzzleEntries[0].meta, ["— solved", "— accuracy", "— lessons"]);
  assert.equal(puzzleEntries[1].primary, "Practice stats");
  assert.deepEqual(puzzleEntries[1].meta, ["12 solved", "75% accuracy", "— lessons"]);
  assert.match(extractFunction("buildLeaderboardEntries"), /getLeaderboardMetrics\(account\)[\s\S]*?puzzleRating === null[\s\S]*?gameRating === null/);
  const mapperStart = app.indexOf("const toLeaderboardEntry = (row = {}) => {");
  const mapperEnd = app.indexOf("const getSupabaseLeaderboard", mapperStart);
  const mapper = app.slice(mapperStart, mapperEnd);
  assert.match(mapper, /const metrics = getLeaderboardMetrics\(row\)/);
  assert.match(mapper, /puzzleRating: metrics\.puzzleRating[\s\S]*?gameRating: metrics\.gameRating/);
  assert.doesNotMatch(mapper, /puzzlesSolved:\s*0|puzzleAccuracy:\s*0|lessonsCompleted:\s*0/);

  const tournaments = productionFunction("buildTournamentLeaderboardEntries", [
    "getFriendCurrentUserId", "getLeaderboardAccountId", "getAuthProvider", "tournamentRuntime", "isTournamentWithinLeaderboardPeriod",
    "isTournamentEntryInScope", "normalizeAuthUsername", "readLeaderboardMetric", "formatProfileNumber", "formatCountryFlag"
  ], [
    () => "current", (account) => account.publicId || "", () => null,
    { events: [{ code: "event-1", title: "Open", status: "active", standings: [
      { id: "missing-score", username: "NoScore", wins: 0 },
      { id: "score-only", username: "ScoreOnly", score: 0 }
    ] }] },
    () => true, () => true, (value) => String(value || ""), readMetric,
    (value) => Number(value).toLocaleString("en-US"), (value) => value || ""
  ]);
  const tournamentRows = tournaments();
  assert.deepEqual(tournamentRows.map((entry) => entry.id), ["score-only"], "rows without an authoritative tournament score do not receive a zero-place result");
  assert.deepEqual(tournamentRows[0].meta, ["Open", "—W —D —L", "— games"], "missing tournament counters remain unavailable");
  console.log("PASS leaderboard regression: game rating never fills missing puzzle rating; puzzle/game/tournament metrics fail closed when absent.");
}

function testNotificationDestinationsAndCounts() {
  const destination = productionFunction("getSocialNotificationDestination");
  const distinctCount = productionFunction("getDistinctUnreadSocialCount");
  assert.deepEqual(destination({ type: "friend_request" }), { tab: "friends", href: "#friends", friendView: "requests" });
  assert.deepEqual(destination({ type: "friend_accepted" }).friendView, "all");
  assert.deepEqual(destination({ type: "message_received", entityId: "conversation-1" }), { tab: "friends", href: "#friends", friendView: "messages", entityId: "conversation-1" });
  assert.deepEqual(destination({ type: "message_received", entityCode: "GAME-1" }), { tab: "friendChallenge", href: "#play?mode=friend" });
  assert.deepEqual(destination({ type: "gift_received" }).action, "giftInbox");
  assert.deepEqual(destination({ type: "achievement_earned" }).href, "#login");
  assert.equal(distinctCount([
    { type: "friend_request", readAt: "" },
    { type: "message_received", readAt: "" },
    { type: "friend_accepted", readAt: "2026-10-01" }
  ], 1, 1), 2, "pending friend requests and direct messages are counted from their authoritative counters, not notification copies");
  assert.equal(distinctCount([{ type: "friend_request", readAt: "" }], -1, 0), 0);
  assert.equal(distinctCount([{ type: "challenge_received", readAt: "" }], 0, 0), 1, "independent unread events remain counted");
  assert.equal(distinctCount([{ type: "friend_request", readAt: "" }, { type: "challenge_received", readAt: "" }], 1, 0), 2, "independent challenge events remain visible beside the authoritative request count");
  console.log("PASS notification regression: navigation badge de-duplicates friend-request/message copies while preserving other unread events.");
}

function makeNotificationReader({ provider, rows = [] }) {
  let accountId = "account-a";
  let socialNotificationGeneration = 1;
  let socialNotificationState = rows;
  let refreshCount = 0;
  let renderCount = 0;
  const status = { textContent: "" };
  const window = { refreshSiteNotifications: () => { refreshCount += 1; } };
  const document = {
    getElementById(id) {
      if (id === "friends") return { hidden: false };
      if (id === "friendsHubStatus") return status;
      if (id === "siteNotificationsStatus") return { textContent: "" };
      if (id === "siteNotificationsDialog") return { hidden: true };
      return null;
    }
  };
  const factory = new Function("provider", "window", "document", "initialRows", "onRender", `
    let socialNotificationGeneration = 1;
    let socialNotificationState = initialRows;
    let currentAccountId = "account-a";
    const getFriendCurrentUserId = () => currentAccountId;
    const isApplicationAuthenticated = () => Boolean(currentAccountId);
    const getFriendProvider = () => provider;
    const renderFriendsHub = () => onRender();
    ${extractFunction("markSocialNotificationsRead")}
    return {
      mark: markSocialNotificationsRead,
      state: () => socialNotificationState,
      status: () => document.getElementById("friendsHubStatus").textContent,
      refreshes: () => window.refreshSiteNotifications ? window.refreshSiteNotifications.count || 0 : 0,
      switchAccount(id) { currentAccountId = id; socialNotificationGeneration += 1; socialNotificationState = []; }
    };
  `);
  // Keep observable counters outside the copied production closure.
  window.refreshSiteNotifications = () => { refreshCount += 1; window.refreshSiteNotifications.count = refreshCount; };
  const instance = factory(provider, window, document, rows, () => { renderCount += 1; });
  return { instance, getRenderCount: () => renderCount, getRefreshCount: () => refreshCount, status, switchAccount: instance.switchAccount };
}

async function testNotificationReadAuthority() {
  let failedCalls = 0;
  const failure = makeNotificationReader({
    rows: [{ id: "notice-1", type: "friend_request", readAt: "" }],
    provider: { markSocialNotificationsRead: async () => { failedCalls += 1; throw new Error("offline"); } }
  });
  assert.equal(await failure.instance.mark(["notice-1"]), false);
  assert.equal(failure.instance.state()[0].readAt, "", "failed server write must not claim the notification is read");
  assert.match(failure.status.textContent, /remains unread/);
  assert.equal(failedCalls, 1);
  assert.equal(await failure.instance.mark([]), false, "an explicit empty selection must not become a mark-all request");
  assert.equal(failedCalls, 1);

  let resolvePending;
  const pending = makeNotificationReader({
    rows: [{ id: "notice-2", type: "gift_received", readAt: "" }],
    provider: { markSocialNotificationsRead: () => new Promise((resolve) => { resolvePending = resolve; }) }
  });
  const completing = pending.instance.mark(["notice-2"]);
  pending.switchAccount("account-b");
  resolvePending();
  assert.equal(await completing, false, "an Account A response after switching accounts is ignored");
  assert.deepEqual(pending.instance.state(), []);

  const success = makeNotificationReader({
    rows: [{ id: "notice-3", type: "challenge_received", readAt: "" }, { id: "notice-4", type: "friend_request", readAt: "" }],
    provider: { markSocialNotificationsRead: async () => undefined }
  });
  assert.equal(await success.instance.mark(["notice-3"]), true);
  assert.ok(success.instance.state()[0].readAt);
  assert.equal(success.instance.state()[1].readAt, "", "only server-confirmed selected rows are marked");
  assert.equal(success.getRefreshCount(), 1);
  console.log("PASS notification read regression: server failure stays unread, empty IDs fail closed, only selected rows update, stale account responses are ignored.");
}

function testSettingsTabContract() {
  const settingsMarkup = html.slice(html.indexOf('id="settingsShell"'), html.indexOf('id="admin"'));
  const tabs = [...settingsMarkup.matchAll(/<button[^>]*role="tab"[^>]*data-settings-tab="([^"]+)"[^>]*>/g)];
  const panels = [...settingsMarkup.matchAll(/<article[^>]*role="tabpanel"[^>]*data-settings-page="([^"]+)"[^>]*>/g)];
  assert.equal(tabs.length, 6);
  assert.equal(panels.length, 6);
  for (const [, name] of tabs) {
    assert.match(settingsMarkup, new RegExp(`id="settingsTab${name[0].toUpperCase()}${name.slice(1)}"[^>]*aria-controls="settingsPage${name[0].toUpperCase()}${name.slice(1)}"`));
    assert.match(settingsMarkup, new RegExp(`id="settingsPage${name[0].toUpperCase()}${name.slice(1)}"[^>]*aria-labelledby="settingsTab${name[0].toUpperCase()}${name.slice(1)}"`));
  }
  const setup = extractFunction("setupSettingsPage");
  for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]) assert.ok(setup.includes(`event.key === "${key}"`), `Settings tab navigation handles ${key}`);
  assert.match(setup, /page\.hidden = !active/);
  assert.match(setup, /window\.addEventListener\("resize", syncTabOrientation, \{ passive: true \}\)/);
  assert.match(settingsMarkup, /id="settingsResetAudio"/);
  assert.match(setup, /writeAudioPrefs\(getDefaultAudioSettings\(\)\)/, "audio reset remains scoped to audio preferences");
  console.log("PASS Settings regression: all panels have linked ARIA tabs; responsive arrow-key navigation and independent audio reset remain wired.");
}

function testStoreAuthorityBoundary() {
  const pendingAction = extractFunction("runStoreItemAction");
  const purchase = extractFunction("buyOrEquipStoreItem");
  assert.match(pendingAction, /storeActionLocks\.has\(id\)[\s\S]*?storeActionLocks\.add\(id\)[\s\S]*?setStoreItemPending\(id, true\)[\s\S]*?finally[\s\S]*?storeActionLocks\.delete\(id\)[\s\S]*?setStoreItemPending\(id, false\)/);
  assert.match(purchase, /storeServerIsActive\(\)[\s\S]*?purchaseCosmetic\(item\.id, createStoreIdempotencyKey\("purchase"\)\)[\s\S]*?refreshServerStoreState/);
  assert.match(purchase, /else \{[\s\S]*?puzzleCoins -= price/);
  assert.match(extractFunction("storeServerRequiresAuthority"), /storeAuthState\.status !== "signed_out"/);
  console.log("PASS Store contract: duplicate action lock, server purchase/idempotency, authority refresh and explicit guest-only wallet fallback remain intact.");
}

(async () => {
  testLeaderboardDataTruthfulness();
  testNotificationDestinationsAndCounts();
  await testNotificationReadAuthority();
  testSettingsTabContract();
  testStoreAuthorityBoundary();
  console.log("PASS Phase 9 remaining-pages regression.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
