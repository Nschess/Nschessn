/*
 * Friends/Social regression for request races, account isolation, action
 * deduplication, truthful presence wording, and view-scoped live services.
 * Async production functions are extracted from assets/app.js and executed
 * with inert providers; this never contacts Supabase or writes test accounts.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8").replace(/\r\n/g, "\n");
const friendsCss = fs.readFileSync(path.join(root, "assets", "routes", "friends.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

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
  let bodyStart = paramsClose + 1;
  while (/\s/.test(app[bodyStart] || "")) bodyStart += 1;
  const open = app[bodyStart] === "{" ? bodyStart : -1;
  assert.notEqual(open, -1, `${name} has a body`);
  let depth = 0;
  let state = "code";
  let escaped = false;
  for (let i = open; i < app.length; i += 1) {
    const ch = app[i];
    const next = app[i + 1];
    if (state === "line-comment") { if (ch === "\n") state = "code"; continue; }
    if (state === "block-comment") { if (ch === "*" && next === "/") { state = "code"; i += 1; } continue; }
    if (state === "single" || state === "double" || state === "template") {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) state = "code";
      continue;
    }
    if (ch === "/" && next === "/") { state = "line-comment"; i += 1; continue; }
    if (ch === "/" && next === "*") { state = "block-comment"; i += 1; continue; }
    if (ch === "'") { state = "single"; continue; }
    if (ch === '"') { state = "double"; continue; }
    if (ch === "`") { state = "template"; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`could not extract complete function ${name}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function testFriendRequestSingleFlight() {
  const locks = new Map();
  const run = new Function("friendRequestActionLocks", `return (${extractFunction("runFriendRequestAction")});`)(locks);
  let accountId = "account-a";
  let sendCalls = 0;
  let refreshCalls = 0;
  const statuses = [];
  const lifecycleCalls = [];
  const pending = deferred();
  const provider = {
    sendFriendRequest: () => { sendCalls += 1; return pending.promise; },
    respondFriendRequest: async (id, accept) => { lifecycleCalls.push(`respond:${id}:${accept}`); },
    cancelFriendRequest: async (id) => { lifecycleCalls.push(`cancel:${id}`); },
    removeFriend: async (id) => { lifecycleCalls.push(`remove:${id}`); }
  };
  const setRequest = new Function(
    "getFriendProvider", "getFriendCurrentUserId", "isApplicationAuthenticated", "setFriendChallengeStatus", "runFriendRequestAction", "refreshFriendNetwork",
    `return (${extractFunction("setFriendRequest")});`
  )(
    () => provider,
    () => accountId,
    () => Boolean(accountId),
    (message) => statuses.push(message),
    run,
    async () => { refreshCalls += 1; return true; }
  );
  const target = { id: "opponent-b", name: "Opponent" };
  const first = setRequest(target, "send");
  const duplicate = setRequest(target, "send");
  const conflict = setRequest(target, "remove");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sendCalls, 1, "rapid repeat clicks make one request");
  pending.resolve({ ok: true });
  await Promise.all([first, duplicate, conflict]);
  assert.equal(refreshCalls, 1, "network refresh follows one completed action");
  assert.deepEqual(statuses, ["Friend request sent to Opponent."]);

  await setRequest({ id: "friend-in", requestId: "request-in", name: "Incoming" }, "accept");
  await setRequest({ id: "friend-in", requestId: "request-in", name: "Incoming" }, "decline");
  await setRequest({ id: "friend-out", requestId: "request-out", name: "Outgoing" }, "cancel");
  await setRequest({ id: "friend-out", name: "Outgoing" }, "remove");
  assert.deepEqual(lifecycleCalls, ["respond:request-in:true", "respond:request-in:false", "cancel:request-out", "remove:friend-out"], "accept/decline/cancel/remove dispatch the established server actions");
  assert.equal(refreshCalls, 5, "each completed server action refreshes authoritative friend state");

  const buttonPromise = deferred();
  let buttonCalls = 0;
  const button = {
    disabled: false,
    isConnected: true,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); }
  };
  const invoke = new Function("setFriendRequest", `return (${extractFunction("invokeFriendRequestAction")});`)(() => { buttonCalls += 1; return buttonPromise.promise; });
  invoke(button, target, "send");
  invoke(button, target, "send");
  assert.equal(button.disabled, true, "the pressed control disables immediately");
  assert.equal(button.attributes.get("aria-busy"), "true", "pending state is exposed accessibly");
  assert.equal(buttonCalls, 1, "the same live button cannot dispatch twice");
  buttonPromise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(button.disabled, false, "a failed or completed in-place action becomes available again");
  assert.equal(button.attributes.has("aria-busy"), false);

  const stalePending = deferred();
  provider.sendFriendRequest = () => { sendCalls += 1; return stalePending.promise; };
  const staleSetRequest = setRequest({ id: "opponent-c", name: "Another" }, "send");
  await Promise.resolve();
  await Promise.resolve();
  accountId = "account-b";
  stalePending.resolve({ ok: true });
  await staleSetRequest;
  assert.equal(refreshCalls, 5, "an old-account action response cannot refresh or message the new account");
  assert.equal(statuses.length, 5);
}

function makeMessagingHarness() {
  const context = {};
  const code = `
    let currentUserId = "account-a";
    let provider = null;
    let friendHubState = { view: "messages" };
    const isApplicationAuthenticated = () => true;
    const getFriendCurrentUserId = () => currentUserId;
    const getFriendProvider = () => provider;
    const normalizeConversation = (row) => ({ ...row });
    const renderFriendsHub = () => {};
    const window = { clearTimeout: () => {} };
    let messagingHubState = { conversations: [], conversationId: "", messages: [], typing: [], muted: false, olderCursor: null, hasOlder: false, readAtByConversation: {}, pending: new Map(), reconnecting: false };
    let messagingRefreshPromise = null;
    let messagingRefreshAccountId = "";
    let messagingRequestGeneration = 0;
    let messagingConversationRequest = 0;
    let messagingRealtimeUnsubscribe = null;
    let messagingReconnectTimer = 0;
    let messagingTypingTimer = 0;
    let messagingTypingStopTimer = 0;
    let messagingRemoteTypingTimer = 0;
    let messagingLastTypingSentAt = 0;
    let messagingRealtimeSubscribing = false;
    ${extractFunction("isCurrentMessagingContext")}
    ${extractFunction("refreshMessaging")}
    ${extractFunction("selectMessagingConversation")}
    ${extractFunction("stopMessagingRealtime")}
    globalThis.testApi = {
      refreshMessaging,
      selectMessagingConversation,
      switchAccount(id) { stopMessagingRealtime(); currentUserId = id; },
      setProvider(value) { provider = value; },
      getConversations() { return messagingHubState.conversations; },
      getMessages() { return messagingHubState.messages; },
      getGeneration() { return messagingRequestGeneration; }
    };
  `;
  vm.runInNewContext(code, context, { timeout: 1000 });
  return context.testApi;
}

async function testMessagingAccountSwitchRace() {
  const harness = makeMessagingHarness();
  const a = deferred();
  const b = deferred();
  const calls = [];
  harness.setProvider({ listConversations: () => { const account = calls.length ? "account-b" : "account-a"; calls.push(account); return account === "account-a" ? a.promise : b.promise; } });
  const requestA = harness.refreshMessaging();
  await Promise.resolve();
  await Promise.resolve();
  harness.switchAccount("account-b");
  const requestB = harness.refreshMessaging();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["account-a", "account-b"], "a new account starts its own request instead of sharing A's promise");
  a.resolve([{ id: "private-a", participantId: "player-a" }]);
  await requestA;
  assert.equal(harness.getConversations().length, 0, "late A conversations are rejected after workspace reset");
  b.resolve([{ id: "private-b", participantId: "player-b" }]);
  await requestB;
  assert.deepEqual(harness.getConversations().map((row) => row.id), ["private-b"]);

  const oldConversationMessages = deferred();
  harness.setProvider({
    getConversationMessages: () => oldConversationMessages.promise,
    markConversationRead: async () => {},
    getConversationTyping: async () => []
  });
  const selectA = harness.selectMessagingConversation({ id: "conversation-a", participantId: "friend-a" }, { open: false });
  await Promise.resolve();
  await Promise.resolve();
  harness.switchAccount("account-c");
  oldConversationMessages.resolve([{ id: "private-a-message", conversation_id: "conversation-a" }]);
  await selectA;
  assert.equal(harness.getMessages().length, 0, "late A conversation hydration is rejected after logout/account transition");
}

async function testSocialRefreshAccountSwitches() {
  const state = {
    currentUserId: "account-a",
    provider: null,
    authenticated: true,
    notificationRows: [],
    activityRows: [],
    notificationRefresh: null,
    notificationAccountId: "",
    notificationGeneration: 0,
    notificationUnsubscribe: null,
    notificationSubscribing: false,
    activityRefresh: null,
    activityAccountId: "",
    activityGeneration: 0,
    activityUnsubscribe: null,
    activitySubscribing: false,
    friendHubState: { view: "notifications" },
    window: { refreshSiteNotifications: () => {} },
    renderFriendsHub: () => {},
    normalizeSocialActivity: (row) => ({ ...row }),
    isApplicationAuthenticated() { return this.authenticated; },
    getFriendCurrentUserId() { return this.currentUserId; },
    getFriendProvider() { return this.provider; },
    stopSocialNotificationRealtime() {
      this.notificationGeneration += 1;
      this.notificationUnsubscribe?.();
      this.notificationUnsubscribe = null;
      this.notificationSubscribing = false;
      this.notificationRefresh = null;
      this.notificationAccountId = "";
      this.notificationRows = [];
    },
    stopSocialActivityRealtime() {
      this.activityGeneration += 1;
      this.activityUnsubscribe?.();
      this.activityUnsubscribe = null;
      this.activitySubscribing = false;
      this.activityRefresh = null;
      this.activityAccountId = "";
      this.activityRows = [];
    }
  };
  const script = `
    let socialNotificationState = state.notificationRows;
    let socialNotificationRefreshPromise = state.notificationRefresh;
    let socialNotificationRefreshAccountId = state.notificationAccountId;
    let socialNotificationGeneration = state.notificationGeneration;
    let socialNotificationUnsubscribe = state.notificationUnsubscribe;
    let socialNotificationSubscribing = state.notificationSubscribing;
    let socialActivityState = state.activityRows;
    let socialActivityRefreshPromise = state.activityRefresh;
    let socialActivityRefreshAccountId = state.activityAccountId;
    let socialActivityGeneration = state.activityGeneration;
    let socialActivityUnsubscribe = state.activityUnsubscribe;
    let socialActivitySubscribing = state.activitySubscribing;
    const friendHubState = state.friendHubState;
    const window = state.window;
    const isApplicationAuthenticated = () => state.isApplicationAuthenticated();
    const getFriendCurrentUserId = () => state.getFriendCurrentUserId();
    const getFriendProvider = () => state.getFriendProvider();
    const normalizeSocialActivity = state.normalizeSocialActivity;
    const renderFriendsHub = state.renderFriendsHub;
    ${extractFunction("refreshSocialNotifications")}
    ${extractFunction("refreshSocialActivity")}
    ${extractFunction("stopSocialNotificationRealtime")}
    ${extractFunction("stopSocialActivityRealtime")}
    function sync() {
      state.notificationRows = socialNotificationState;
      state.notificationRefresh = socialNotificationRefreshPromise;
      state.notificationAccountId = socialNotificationRefreshAccountId;
      state.notificationGeneration = socialNotificationGeneration;
      state.activityRows = socialActivityState;
      state.activityRefresh = socialActivityRefreshPromise;
      state.activityAccountId = socialActivityRefreshAccountId;
      state.activityGeneration = socialActivityGeneration;
    }
    globalThis.testApi = {
      refreshSocialNotifications: async () => { const result = await refreshSocialNotifications(); sync(); return result; },
      refreshSocialActivity: async () => { const result = await refreshSocialActivity(); sync(); return result; },
      invalidate() { stopSocialNotificationRealtime(); stopSocialActivityRealtime(); sync(); }
    };
  `;
  const context = vm.createContext({ state });
  vm.runInContext(script, context, { timeout: 1000 });
  const harness = context.testApi;
  const notificationA = deferred();
  const notificationB = deferred();
  const activityA = deferred();
  const activityB = deferred();
  const calls = [];
  state.provider = {
    getSocialNotifications: () => { const id = calls.filter((call) => call.startsWith("n:")).length ? "account-b" : "account-a"; calls.push(`n:${id}`); return id === "account-a" ? notificationA.promise : notificationB.promise; },
    getSocialActivityFeed: () => { const id = calls.filter((call) => call.startsWith("a:")).length ? "account-b" : "account-a"; calls.push(`a:${id}`); return id === "account-a" ? activityA.promise : activityB.promise; }
  };
  const nA = harness.refreshSocialNotifications();
  const aA = harness.refreshSocialActivity();
  await Promise.resolve();
  await Promise.resolve();
  harness.invalidate();
  state.currentUserId = "account-b";
  state.friendHubState.view = "messages";
  state.provider.getSocialNotifications = () => { calls.push("n:account-b"); return notificationB.promise; };
  state.provider.getSocialActivityFeed = () => { calls.push("a:account-b"); return activityB.promise; };
  const nB = harness.refreshSocialNotifications();
  const aB = harness.refreshSocialActivity();
  await Promise.resolve();
  await Promise.resolve();
  notificationA.resolve([{ id: "private-a-note", type: "friend_request" }]);
  activityA.resolve([{ id: "private-a-activity", type: "game" }]);
  await Promise.all([nA, aA]);
  assert.equal(state.notificationRows.length, 0, "late A notifications cannot populate B state");
  assert.equal(state.activityRows.length, 0, "late A activity cannot populate B state");
  notificationB.resolve([{ id: "private-b-note", type: "friend_request" }]);
  activityB.resolve([{ id: "private-b-activity", type: "game" }]);
  await Promise.all([nB, aB]);
  assert.deepEqual(state.notificationRows.map((row) => row.id), ["private-b-note"]);
  assert.deepEqual(state.activityRows.map((row) => row.id), ["private-b-activity"]);
}

function testLazyServicesAndTruthfulPresence() {
  const setup = extractFunction("setupFriendsHub");
  const viewServices = extractFunction("ensureFriendsHubViewServices");
  assert.match(setup, /ensureFriendsHubViewServices\(\)/);
  assert.doesNotMatch(setup, /void refreshSocialActivity\(\)\.then\(renderFriendsHub\)/, "activity is not fetched on every Friends entry");
  assert.doesNotMatch(setup, /void refreshMessaging\(\{ selectFirst: true \}\);\s*ensureMessagingRealtime\(\);\s*void refreshSocialActivity/, "messages are not fetched on every Friends entry");
  assert.match(viewServices, /friendHubState\.view === "messages"[\s\S]*?refreshMessaging[\s\S]*?ensureMessagingRealtime/);
  assert.match(viewServices, /friendHubState\.view === "activity"[\s\S]*?refreshSocialActivity[\s\S]*?ensureSocialActivityRealtime/);
  assert.match(extractFunction("ensureMessagingRealtime"), /requestGeneration[\s\S]*?isCurrentMessagingContext[\s\S]*?unsubscribe/);
  assert.match(extractFunction("ensureSocialNotificationRealtime"), /socialNotificationGeneration[\s\S]*?expectedUserId[\s\S]*?unsubscribe/);
  assert.match(extractFunction("ensureSocialActivityRealtime"), /socialActivityGeneration[\s\S]*?expectedUserId[\s\S]*?unsubscribe/);
  assert.doesNotMatch(html, /friendsHubLiveStatus[^>]*>\s*<span[^>]*><\/span>\s*Live/);
  assert.match(html, /friendsHubLiveStatus[^>]*aria-label="Sign in for live presence"/);
  assert.match(extractFunction("updateFriendsHubRealtimeBadge"), /friendRealtimeReady[\s\S]*?Live updates connected[\s\S]*?Live updates unavailable/);
  assert.match(friendsCss, /\.friends-hub-live\.is-offline\s*\{[^}]*color:/);
  assert.match(friendsCss, /\.friends-hub-nav-list button \{ flex:0 0 auto; min-height:44px; \}/);
  assert.match(friendsCss, /\.friends-hub-card-actions \.button,[\s\S]*?\.friends-hub-message-form \.button \{ min-height:44px; \}/);
  assert.match(extractFunction("searchFriendPlayers"), /requestId = \+\+friendSearchRequest[\s\S]*?await provider\.searchRegisteredPlayers[\s\S]*?requestId !== friendSearchRequest/);
  assert.match(extractFunction("setupFriendsHub"), /friendSearchRequest \+= 1;[\s\S]*?friendNetworkState\.search = \[\]/);
  assert.match(extractFunction("friendPresenceLabel"), /presenceConfirmed \? \(friend\.online \? "Online" : "Offline"\) : labels\.unknown/, "unknown presence remains unavailable rather than inferred");
}

function testFriendsHubPresenceBadge() {
  const badge = {
    classList: { toggle() {} },
    setAttribute() {},
    querySelector: () => ({ classList: { toggle() {} }, textContent: "" })
  };
  const status = { textContent: "" };
  const elements = { friendsHubLiveStatus: badge, friendsHubStatus: status };
  let authenticated = true;
  let realtimeReady = false;
  const networkState = { directory: [{ requestStatus: "accepted", online: true }] };
  const connectionState = { state: "idle" };
  const context = {
    document: { getElementById: (id) => elements[id] || null },
    isApplicationAuthenticated: () => authenticated,
    friendRealtimeReady: realtimeReady,
    friendConnectionState: connectionState,
    friendNetworkSubscribing: false,
    friendNetworkState: networkState
  };
  const update = new Function("document", "isApplicationAuthenticated", "friendRealtimeReady", "friendConnectionState", "friendNetworkSubscribing", "friendNetworkState", `return (${extractFunction("updateFriendsHubRealtimeBadge")});`)(
    context.document,
    context.isApplicationAuthenticated,
    realtimeReady,
    connectionState,
    false,
    networkState
  );
  update();
  assert.equal(status.textContent, "Live presence unavailable.", "cached online rows are not advertised while realtime is disconnected");

  realtimeReady = true;
  const connectedUpdate = new Function("document", "isApplicationAuthenticated", "friendRealtimeReady", "friendConnectionState", "friendNetworkSubscribing", "friendNetworkState", `return (${extractFunction("updateFriendsHubRealtimeBadge")});`)(
    context.document,
    () => authenticated,
    realtimeReady,
    connectionState,
    false,
    networkState
  );
  connectedUpdate();
  assert.equal(status.textContent, "1 online · live updates connected.", "online count is shown only with a confirmed live connection");

  authenticated = false;
  const guestUpdate = new Function("document", "isApplicationAuthenticated", "friendRealtimeReady", "friendConnectionState", "friendNetworkSubscribing", "friendNetworkState", `return (${extractFunction("updateFriendsHubRealtimeBadge")});`)(
    context.document,
    () => authenticated,
    true,
    connectionState,
    false,
    networkState
  );
  guestUpdate();
  assert.equal(status.textContent, "Sign in to connect your Friends network.", "guest state does not claim presence data");
}

async function run() {
  await testFriendRequestSingleFlight();
  await testMessagingAccountSwitchRace();
  await testSocialRefreshAccountSwitches();
  testLazyServicesAndTruthfulPresence();
  testFriendsHubPresenceBadge();
  console.log("friends-social-regression: request deduplication, stale-account rejection, lazy streams, and truthful presence passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
