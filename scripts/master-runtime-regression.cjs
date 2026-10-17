"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets/app.js"), "utf8").replace(/\r/g, "");
// Extract whole production declarations at their shared-runtime indentation.
function declaration(name) {
  const start = app.search(new RegExp(`^    (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const endPattern = /^    }$/gm;
  endPattern.lastIndex = start;
  const end = endPattern.exec(app)?.index ?? -1;
  assert.ok(end > start, name);
  return app.slice(start, end + 5);
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function storeRace({ stale = true, rejected = false, roundTrip = false } = {}) {
  const pending = deferred();
  const effects = [];
  const context = vm.createContext({
    storeSessionGeneration: 0, storeAuthState: { status: "authenticated", userId: "A" },
    applicationAuthAccount: { authUserId: "A" }, getFriendCurrentUserId: () => "A",
    storeState: { owned: [], equipped: {} }, puzzleCoins: 100, serverStoreState: { coins: 100 },
    getStoreItem: () => ({ id: "test", type: "board", cost: 10, name: "Test board" }),
    getEquippedStoreId: () => "old", storeServerRequiresAuthority: () => true,
    ensureServerStoreReady: async () => true, storeServerIsActive: () => true,
    getStoreUnlockMethod: () => "Coins", getStoreUnlockMethodLabel: () => "Coins",
    validateServerStoreItem: () => ({ ok: true }), getStoreServerCost: () => 10,
    getAuthProvider: () => ({ purchaseCosmetic: () => pending.promise }), createStoreIdempotencyKey: () => "synthetic",
    document: { getElementById: () => null }, location: { search: "" }, URLSearchParams,
    reportStorePurchaseDiagnostic: () => effects.push("diagnostic"),
    refreshServerStoreState: async () => effects.push("refresh"),
    recordStoreHistory: () => effects.push("history"), playAudioCue: () => effects.push("sound"),
    showCelebration: () => effects.push("success"), equipStoreItem: async () => { effects.push("equip"); return true; },
    savePuzzleState: () => effects.push("persist"), refreshStoreItemCards: () => {}, renderBeginnerProgress: () => {}
  });
  if (app.includes("function captureStoreSession(")) vm.runInContext(declaration("captureStoreSession"), context);
  vm.runInContext(declaration("buyOrEquipStoreItem"), context);
  const action = vm.runInContext('buyOrEquipStoreItem("test")', context);
  await new Promise((resolve) => setImmediate(resolve));
  if (stale) {
    context.storeSessionGeneration += roundTrip ? 2 : 1;
    context.storeAuthState = { status: "authenticated", userId: roundTrip ? "A" : "B" };
    context.applicationAuthAccount = { authUserId: roundTrip ? "A" : "B" };
    context.puzzleCoins = 777;
  }
  if (rejected) pending.reject(new Error("Synthetic server failure"));
  else pending.resolve({ coins: 90 });
  await action;
  if (stale) {
    assert.equal(context.puzzleCoins, 777, "a stale purchase must not replace the current wallet");
    assert.deepEqual(effects, [], "stale purchase must not equip, persist, celebrate or refresh");
  } else if (rejected) {
    assert.equal(context.puzzleCoins, 100);
    assert.deepEqual(effects, ["diagnostic"]);
  } else {
    assert.equal(context.puzzleCoins, 90);
    assert.ok(effects.includes("equip") && effects.includes("persist") && effects.includes("success"));
  }
  console.log(`PASS production purchase ${JSON.stringify({ stale, rejected, roundTrip })}`);
}

async function otherStoreRaces() {
  const pending = deferred();
  const context = vm.createContext({ storeSessionGeneration: 0, storeServerRequiresAuthority: () => false,
    storeServerIsActive: () => true, validateServerStoreItem: () => ({ ok: true }),
    getAuthProvider: () => ({ equipCosmetic: () => pending.promise }),
    refreshServerStoreState: async () => { throw new Error("Stale equip must not refresh another account"); },
    document: { getElementById: () => { throw new Error("Stale equip must not repaint another account"); } }
  });
  vm.runInContext(declaration("captureStoreSession") + declaration("equipStoreItem"), context);
  const action = vm.runInContext('equipStoreItem({id:"test",type:"board"})', context);
  context.storeSessionGeneration += 1;
  pending.resolve();
  assert.equal(await action, false);

  const status = { textContent: "" };
  const bundleContext = vm.createContext({ storeSessionGeneration: 0, storeBundles: [{ id: "bundle", name: "Test" }],
    storeServerRequiresAuthority: () => false, document: { getElementById: () => status },
    getStoreBundleDetails: () => ({ items: [{ id: "item" }], missingItems: [] }), equipStoreItem: async () => false,
    savePuzzleState: () => { throw new Error("Failed equip must not persist success"); }
  });
  vm.runInContext(declaration("captureStoreSession") + declaration("performStoreBundleAction"), bundleContext);
  await vm.runInContext('performStoreBundleAction("bundle")', bundleContext);
  assert.match(status.textContent, /could not be equipped/);

  const inbox = deferred();
  const inboxContext = vm.createContext({ storeSessionGeneration: 0, getFriendCurrentUserId: () => "A",
    getAuthProvider: () => ({ listGiftInbox: () => inbox.promise }), isApplicationAuthenticated: () => true,
    giftInboxState: [], renderStoreGiftInbox: () => { throw new Error("Stale gifts must not render"); }
  });
  vm.runInContext(declaration("captureStoreSession") + declaration("refreshStoreGiftInbox"), inboxContext);
  const load = vm.runInContext("refreshStoreGiftInbox()", inboxContext);
  inboxContext.storeSessionGeneration += 2;
  inbox.resolve([{ id: "old-session-private-gift" }]);
  await load;
  assert.equal(inboxContext.giftInboxState.length, 0);
  console.log("PASS production equip, partial bundle and A-B-A gift isolation");
}

async function storeLockOwnership() {
  const first = deferred(), second = deferred();
  let calls = 0;
  const context = vm.createContext({ storeSessionGeneration: 0, storeActionLocks: new Map(),
    getStoreItem: () => ({ id: "item", name: "Synthetic item" }),
    buyOrEquipStoreItem: () => (++calls === 1 ? first.promise : second.promise),
    setStoreItemPending: () => {}, refreshStoreItemCards: () => {}, document: { getElementById: () => null }
  });
  vm.runInContext(declaration("runStoreItemAction"), context);
  const a = vm.runInContext('runStoreItemAction("item")', context);
  await vm.runInContext('runStoreItemAction("item")', context);
  assert.equal(calls, 1, "double click sends only one action");
  context.storeActionLocks.clear(); context.storeSessionGeneration++;
  const b = vm.runInContext('runStoreItemAction("item")', context);
  first.resolve(); await a;
  assert.equal(context.storeActionLocks.get("item"), 1, "A's finally cannot release B's lock");
  context.storeSessionGeneration++; // auth error while action is in flight
  second.resolve(); await b;
  assert.equal(context.storeActionLocks.size, 0, "auth errors must not leave an owned lock stuck forever");
  console.log("PASS Store duplicate-click, replacement-lock ownership and error cleanup");
}

async function storeHydrationOwnership() {
  for (const rejected of [false, true]) {
    const pending = deferred();
    const newerRefresh = Promise.resolve("current session");
    const context = vm.createContext({ storeSessionGeneration: 0,
      serverStoreRefreshPromise: null, serverStoreRefreshAccountId: "", serverStoreState: { coins: 100 },
      serverStoreSyncStatus: "idle", serverStoreSyncError: null, serverStoreMissingIds: [],
      applicationAuthAccount: { authUserId: "A" }, normalizeAccountWorkspaceId: (id) => id,
      getAuthoritativeStoreUser: async () => ({ id: "A" }), isApplicationAuthenticated: () => true,
      getAuthProvider: () => ({ getStoreState: () => pending.promise }), renderStoreSyncFeedback: () => {}
    });
    vm.runInContext(declaration("captureStoreSession") + declaration("refreshServerStoreState"), context);
    const action = vm.runInContext("refreshServerStoreState()", context);
    await new Promise((resolve) => setImmediate(resolve));
    context.storeSessionGeneration += 2; // A -> B -> A, same ID but new ownership.
    context.serverStoreState = { coins: 777 };
    context.serverStoreRefreshPromise = newerRefresh;
    if (rejected) pending.reject(new Error("Old session error")); else pending.resolve({ coins: 1 });
    assert.equal(await action, null);
    assert.equal(context.serverStoreState.coins, 777, "late hydration cannot replace the new wallet");
    assert.equal(context.serverStoreRefreshPromise, newerRefresh, "old finally cannot clear a new refresh");
    assert.equal(context.serverStoreSyncError, null, "old rejection cannot become the new session's error");
  }
  const pending = deferred();
  const context = vm.createContext({ storeSessionGeneration: 0, storeAuthResolutionPromise: null,
    storeAuthState: { status: "unknown", userId: "" },
    getAuthProvider: () => ({ getAuthenticatedUserId: () => pending.promise }),
    setStoreAuthState: () => { throw new Error("Old authentication must not replace the new account"); }
  });
  vm.runInContext(declaration("captureStoreSession") + declaration("getAuthoritativeStoreUser"), context);
  const action = vm.runInContext("getAuthoritativeStoreUser()", context);
  context.storeSessionGeneration++;
  pending.resolve("A");
  assert.equal(await action, null);
  console.log("PASS production Store auth/hydration reject old sessions and preserve replacement promises");
}

async function notificationRace() {
  for (const boundary of ["none", "account", "route"]) {
    const pending = deferred();
    let callback;
    let selections = 0;
    const context = vm.createContext({ siteNavigationGeneration: 0, socialNotificationGeneration: 0,
      getFriendCurrentUserId: () => "A", saveFriendHubState: () => {},
      getSocialNotificationDestination: () => ({ tab: "friends", href: "#friends", friendView: "messages", entityId: "thread" }),
      window: { setTimeout: (fn) => { callback = fn; } }, refreshMessaging: () => pending.promise,
      messagingHubState: { conversations: [{ id: "thread" }] }, selectMessagingConversation: () => { selections += 1; }
    });
    vm.runInContext(declaration("routeToSocialNotification"), context);
    vm.runInContext("routeToSocialNotification({}, () => {})", context);
    callback();
    if (boundary === "account") context.socialNotificationGeneration += 2;
    if (boundary === "route") context.siteNavigationGeneration += 2;
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selections, boundary === "none" ? 1 : 0, `notification ${boundary} ownership`);
  }
  console.log("PASS notification routing rejects delayed selection after account/navigation changes");
}

async function configCooldown() {
  const start = app.indexOf("      const getConfig = async () => {");
  const end = app.indexOf("\n      };", start);
  assert.ok(start > 0 && end > start);
  let now = 0, requests = 0, healthy = false;
  const context = vm.createContext({ configPromise: null, configRetryAt: 0, configLastError: null,
    Date: { now: () => now }, window: { NschessAuthRedirectPolicy: { trustedOrigins: () => ["https://test.invalid"] } },
    fetch: async () => { requests += 1; return { ok: healthy, json: async () => healthy ? { url: "https://test.invalid", anonKey: "synthetic" } : {} }; }
  });
  vm.runInContext(app.slice(start, end + 9) + "\nthis.readConfig = getConfig;", context);
  for (let i = 0; i < 7; i++) await assert.rejects(context.readConfig());
  assert.equal(requests, 1, "one failed configuration fetch per cooldown, not one per surface");
  now = 3001; healthy = true;
  assert.equal((await context.readConfig()).url, "https://test.invalid");
  assert.equal(requests, 2, "reconnection may retry after bounded cooldown");
  await context.readConfig();
  assert.equal(requests, 2, "successful config is still shared");
  console.log("PASS auth config failure coalescing and subsequent recovery");
}

async function reviewRehydrationRace() {
  for (const boundary of ["none", "account", "roundTrip", "route", "failedSetup"]) {
    const pending = deferred();
    const saved = { id: "synthetic-review" };
    let opened = 0;
    const context = vm.createContext({ siteNavigationGeneration: 0, socialNotificationGeneration: 0,
      initializeDeferredFeature: () => pending.promise, isApplicationAuthenticated: () => true,
      normalizeAccountWorkspaceId: (id) => id, applicationAuthAccount: { authUserId: "A" },
      matchReviews: [saved], isGameReviewRoute: () => true,
      document: { getElementById: () => ({ classList: { contains: () => false } }) },
      openSavedMatchReview: () => { opened += 1; }, saved
    });
    vm.runInContext(declaration("reopenAccountReviewWhenReady"), context);
    vm.runInContext('reopenAccountReviewWhenReady(saved, "A")', context);
    if (boundary === "account") context.applicationAuthAccount = { authUserId: "B" };
    if (boundary === "roundTrip") context.socialNotificationGeneration += 2;
    if (boundary === "route") context.siteNavigationGeneration += 2;
    pending.resolve(boundary === "failedSetup" ? false : undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened, boundary === "none" ? 1 : 0, `deferred saved Review ${boundary}`);
  }
  console.log("PASS deferred saved Review rejects account, A-B-A, route and failed-initialization races");
}

async function workerCache() {
  const handlers = {};
  const entries = new Map();
  let badResponse = false;
  const context = vm.createContext({
    URL, Response, Request, Promise,
    self: { location: { origin: "https://local.test", href: "https://local.test/service-worker.js" }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { open: async () => ({ put: async (request, value) => entries.set(request.url, value),
      keys: async () => [...entries.keys()].map((url) => new Request(url)), delete: async (request) => entries.delete(request.url) }), match: async (request) => entries.get(request.url) },
    fetch: async () => new Response(badResponse ? "bad gateway" : "good app", { status: badResponse ? 503 : 200 })
  });
  const source = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  vm.runInContext(source, context);
  async function get() {
    const tasks = [];
    let response;
    handlers.fetch({ request: new Request("https://local.test/assets/app.js"), respondWith: (p) => { response = p; }, waitUntil: (p) => tasks.push(p) });
    const value = await response;
    await Promise.all(tasks);
    await new Promise((resolve) => setImmediate(resolve));
    return value;
  }
  assert.equal(await (await get()).text(), "good app");
  badResponse = true;
  await get();
  assert.equal(await entries.get("https://local.test/assets/app.js").clone().text(), "good app", "HTTP failure must not poison a working offline shell");
  assert.ok(!source.includes('CACHE_NAME = "nschess-shell-v192-'), "changed release assets require a fresh cache generation");
  console.log("PASS production service worker preserves valid cached shell on HTTP error; release cache renewed");
}

(async () => {
  let failures = 0;
  for (const test of [storeRace, () => storeRace({ rejected: true }), () => storeRace({ roundTrip: true }),
    () => storeRace({ stale: false }), () => storeRace({ stale: false, rejected: true }), otherStoreRaces, storeLockOwnership, storeHydrationOwnership, notificationRace, reviewRehydrationRace, configCooldown, workerCache]) {
    try { await test(); } catch (error) { failures += 1; console.error(error.message); }
  }
  assert.equal(failures, 0, "runtime defects must be resolved");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
