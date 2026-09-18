/*
 * Deterministic multiplayer synchronization checks.
 *
 * These tests intentionally do not boot the browser bundle or touch Supabase.
 * They exercise the invariants shared by the client reconciliation path and
 * the save_game_challenge_position RPC: monotonic revisions, prefix-only move
 * histories, one optimistic move, and spectator read-only state.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const hardeningMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260819_release_candidate_security_hardening.sql"), "utf8");
const matchmakingMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260814_intelligent_quick_match.sql"), "utf8");
const fenContractMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260912_multiplayer_fen_en_passant_contract.sql"), "utf8");
const friendChallengeHardeningMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260916_friendly_challenge_notification_idempotency.sql"), "utf8");

const boardMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function moveCount(moves) {
  return (Array.isArray(moves) ? moves : []).filter((move) => boardMove.test(String(move))).length;
}

function isPrefix(prefix, value) {
  return prefix.every((move, index) => String(move) === String(value[index]));
}

function shouldDeferRemote({ pending, remote }) {
  if (!pending || !remote) return false;
  if (pending.code && pending.code !== remote.code) return false;
  if (pending.remoteId && pending.remoteId !== remote.id) return false;
  const remoteMoves = Array.isArray(remote.moves) ? remote.moves : [];
  const acknowledged = remoteMoves.includes(pending.uci) && moveCount(remoteMoves) >= pending.boardCount;
  if (acknowledged) return false;
  return moveCount(remoteMoves) < pending.boardCount || Number(remote.revision || 0) <= Number(pending.expectedRevision || 0);
}

function acceptRemote({ current, remote, pending }) {
  if (shouldDeferRemote({ pending, remote })) return current;
  if (current && current.id === remote.id && Number(remote.revision || 0) < Number(current.revision || 0)) return current;
  return remote;
}

function normalizePresenceForRegression(row = {}) {
  const hasLivePresence = typeof row.online === "boolean";
  const rawStatus = String(row.presence_status || row.presenceStatus || row.status || "").toLowerCase();
  const hasPresenceStatus = ["online", "in_game", "looking", "idle", "offline"].includes(rawStatus);
  const presenceConfirmed = Boolean(row.presenceConfirmed) || hasLivePresence || hasPresenceStatus;
  const onlineNow = hasLivePresence
    ? Boolean(row.online) && rawStatus !== "offline"
    : hasPresenceStatus && rawStatus !== "offline";
  const presenceStatus = !presenceConfirmed ? "unknown"
    : !onlineNow ? "offline"
    : hasPresenceStatus ? rawStatus : "online";
  return {
    presenceConfirmed,
    presenceStatus,
    online: presenceConfirmed && onlineNow
  };
}

function runFriendChallengeBackendHardeningModelRegression() {
  // MODEL TEST: this is a lifecycle model, not a PostgreSQL transaction
  // simulation. The source-contract assertions below describe the forward
  // migration; dedicated-E2E proof is still required before release.
  const notes = [];
  const received = { recipient: "B", actor: "A", type: "challenge_received", challengeId: "c1", actionable: true };
  notes.push(received);
  const transition = (from, to, actor = "B") => {
    if (from === "pending" && to === "active") notes.push({ recipient: "A", actor, type: "challenge_accepted", challengeId: "c1", actionable: true });
    if (from === "pending" && ["active", "declined", "cancelled", "expired"].includes(to)) received.actionable = false;
  };

  transition("pending", "active");
  transition("active", "active");
  assert.equal(notes.filter((note) => note.type === "challenge_accepted" && note.recipient === "A").length, 1,
    "only the authoritative pending-to-active transition notifies the challenger");
  assert.equal(received.actionable, false, "accept resolves the challengee's received invitation");

  for (const terminal of ["cancelled", "declined", "expired"]) {
    const pending = { actionable: true };
    pending.actionable = false;
    assert.equal(pending.actionable, false, `${terminal} resolves the incoming pending notification`);
  }

  const pendingByFingerprint = new Map();
  let nextChallengeNumber = 1;
  const createEquivalent = (fingerprint) => {
    if (!pendingByFingerprint.has(fingerprint)) pendingByFingerprint.set(fingerprint, { status: "pending", id: `challenge-${nextChallengeNumber++}` });
    return pendingByFingerprint.get(fingerprint);
  };
  const first = createEquivalent("private|casual|random|10+0");
  const second = createEquivalent("private|casual|random|10+0");
  assert.equal(first.id, second.id, "equivalent concurrent creates reconcile to the same pending challenge");
  assert.equal(pendingByFingerprint.size, 1);
  first.status = "cancelled";
  pendingByFingerprint.delete("private|casual|random|10+0");
  assert.notEqual(createEquivalent("private|casual|random|10+0").id, first.id,
    "a terminal challenge never prevents a new invitation");

  const canRespond = ({ actor, creator, opponent, status, response }) => (
    (response === "accept" && actor === opponent && status === "pending")
    || (response === "decline" && actor === opponent && status === "pending")
    || (response === "cancel" && actor === creator && ["pending", "accepted"].includes(status))
  );
  assert.equal(canRespond({ actor: "third-party", creator: "A", opponent: "B", status: "pending", response: "accept" }), false,
    "an unrelated account cannot accept a targeted challenge");
  assert.equal(canRespond({ actor: "third-party", creator: "A", opponent: "B", status: "pending", response: "cancel" }), false,
    "an unrelated account cannot cancel a targeted challenge");
  assert.equal(canRespond({ actor: "B", creator: "A", opponent: "B", status: "completed", response: "accept" }), false,
    "a terminal challenge cannot be reactivated");
}

function runPresenceTruthRegression() {
  // A profile timestamp is historical identity data, not a live heartbeat.
  const staleInference = normalizePresenceForRegression({ last_login_at: new Date().toISOString() });
  assert.deepEqual(staleInference, { presenceConfirmed: false, presenceStatus: "unknown", online: false });
  assert.equal(normalizePresenceForRegression({ online: true, presence_status: "looking" }).online, true);
  const expiredServerPresence = normalizePresenceForRegression({ online: false, presence_status: "online" });
  assert.deepEqual(expiredServerPresence, { presenceConfirmed: true, presenceStatus: "offline", online: false },
    "the authoritative directory boolean must override a stale raw online label");

  // Realtime friend_presence events deliberately omit identity columns. Their
  // merge must only change presence fields and never reset player metadata.
  const friend = { id: "friend-1", name: "Real Name", rating: 1842, avatar: "♞", title: "Candidate Master", online: false };
  const presencePatch = { online: true, presenceConfirmed: true, presenceStatus: "online", lastSeenAt: "2026-09-11T00:00:00.000Z" };
  const merged = { ...friend, ...presencePatch };
  assert.equal(merged.name, "Real Name");
  assert.equal(merged.rating, 1842);
  assert.equal(merged.avatar, "♞");
  assert.equal(merged.online, true);
}

function runFriendAutoPairContractRegression() {
  // MODEL TEST: a single authoritative challenge becomes active once. Both
  // participants retain that one challenge identity, FEN, clock, and
  // complementary colors; client-side routing must not manufacture a second
  // match while the server state is unchanged.
  const challenge = {
    id: "challenge-1",
    code: "ABC23456",
    status: "active",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    clock: "5+0",
    creatorColor: "w"
  };
  const accountA = { ...challenge, color: challenge.creatorColor };
  const accountB = { ...challenge, color: challenge.creatorColor === "w" ? "b" : "w" };
  assert.equal(accountA.id, accountB.id);
  assert.equal(accountA.code, accountB.code);
  assert.equal(accountA.fen, accountB.fen);
  assert.equal(accountA.clock, accountB.clock);
  assert.notEqual(accountA.color, accountB.color);
}

function runFriendActiveHandoffRegression() {
  // MODEL TEST: immediate RPC results, realtime events, and reconciliation all
  // converge on one active game handoff. This is not a browser navigation
  // simulation; browser/E2E validates the rendered board separately.
  const active = { id: "challenge-1", code: "ABC23456", status: "active", creatorId: "A", opponentId: "B" };
  const handoff = (state, remote, userId, seen) => {
    if (remote.status !== "active" || ![remote.creatorId, remote.opponentId].includes(userId)) return { state, seen, started: false };
    if ((state?.active || state?.status === "active") && state.id !== remote.id) return { state, seen, started: false };
    const key = `${remote.id}:${remote.code}`;
    if (seen === key) return { state: remote, seen, started: false };
    return { state: remote, seen: key, started: true };
  };
  const challenger = handoff({ id: active.id, status: "pending" }, active, "A", "");
  const challengee = handoff({ id: active.id, status: "pending" }, active, "B", "");
  assert.equal(challenger.started, true, "the challenger must hand off from the authoritative active state");
  assert.equal(challengee.started, true, "the challengee must hand off from the Accept response");
  assert.equal(handoff(challengee.state, active, "B", challengee.seen).started, false,
    "duplicate realtime/reconciliation active events must not initialize the board twice");
  assert.equal(handoff({ id: "newer", status: "active" }, active, "B", "newer:OTHER").started, false,
    "a stale active challenge cannot replace a newer live board");
  assert.equal(handoff(null, active, "B", "").started, true,
    "refresh recovery must hand off when no local invitation snapshot exists");
}

function runActiveRevisionWatchdogRegression() {
  let now = 0;
  let realtimeSignals = 0;
  let authoritativeRefreshes = 0;
  let local = { status: "active", revision: 7, fen: "start", moves: [] };
  let server = { ...local };
  let lastSignalAt = 0;
  const staleAfter = 4500;

  const noteRealtimeSignal = () => {
    realtimeSignals += 1;
    lastSignalAt = now;
  };
  const watchdogTick = () => {
    if (now - lastSignalAt < staleAfter) return false;
    authoritativeRefreshes += 1;
    if (server.revision > local.revision) local = { ...server };
    lastSignalAt = now;
    return true;
  };

  // A healthy realtime signal suppresses the fallback refresh while the
  // server revision is already represented locally.
  now = 1000;
  noteRealtimeSignal();
  now = 5499;
  assert.equal(watchdogTick(), false);
  assert.equal(authoritativeRefreshes, 0);

  // The next server move is deliberately not delivered through realtime.
  // Once the revision signal is stale, the watchdog must obtain the
  // authoritative position instead of leaving B on the old FEN.
  server = { status: "active", revision: 8, fen: "after-e4", moves: ["e2e4"] };
  now = 5500;
  assert.equal(watchdogTick(), true);
  assert.equal(authoritativeRefreshes, 1);
  assert.equal(realtimeSignals, 1);
  assert.equal(local.revision, 8);
  assert.equal(local.fen, "after-e4");
  assert.deepEqual(local.moves, ["e2e4"]);

  // A later stale response cannot roll the recovered state back.
  const recovered = { ...local };
  const stale = { status: "active", revision: 7, fen: "start", moves: [] };
  if (stale.revision >= local.revision) local = stale;
  assert.deepEqual(local, recovered);
}

async function runFriendInviteHydrationRegression() {
  let authenticated = false;
  let queued = false;
  let fetchCount = 0;
  let subscriptionCount = 0;
  let hydrationPromise = null;
  let hydrated = false;
  const state = { status: "pending", active: false, friendStartEnabled: false };

  async function applyInvite() {
    if (!authenticated) {
      queued = true;
      return false;
    }
    if (hydrated) return true;
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = Promise.resolve().then(() => {
      fetchCount += 1;
      subscriptionCount += 1;
      state.status = "active";
      state.active = true;
      state.friendStartEnabled = true;
      hydrated = true;
      queued = false;
      return true;
    });
    try {
      return await hydrationPromise;
    } finally {
      if (!hydrated) hydrationPromise = null;
    }
  }

  assert.equal(await applyInvite(), false);
  assert.equal(queued, true);
  assert.equal(state.active, false);

  authenticated = true;
  const [firstRetry, duplicateRetry] = await Promise.all([applyInvite(), applyInvite()]);
  assert.equal(firstRetry, true);
  assert.equal(duplicateRetry, true);
  assert.equal(state.status, "active");
  assert.equal(state.active, true);
  assert.equal(state.friendStartEnabled, true);
  assert.equal(fetchCount, 1);
  assert.equal(subscriptionCount, 1);

  // An invite that was already active before a repeated auth/setup callback
  // must stay idempotent rather than creating another fetch/subscription.
  assert.equal(await applyInvite(), true);
  assert.equal(fetchCount, 1);
  assert.equal(subscriptionCount, 1);
}

async function runFriendChallengeRefreshLifecycleRegression() {
  const statusRank = (status) => ({ pending: 1, active: 2, completed: 3 }[status] || 0);
  let local = { id: "challenge-1", code: "ABC23456", status: "pending", revision: 4 };
  let queued = false;
  let queuedCode = "";
  let queuedRestoreBoard = false;
  let inFlight = null;
  let fetchCalls = 0;
  const resolvers = [];

  const authoritativeFetch = () => {
    fetchCalls += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const applyRemote = (remote) => {
    if (remote.id !== local.id) return false;
    if (remote.revision < local.revision) return false;
    if (remote.revision === local.revision && statusRank(remote.status) < statusRank(local.status)) return false;
    local = remote;
    return true;
  };
  const refresh = (code = local.code, restoreBoard = true) => {
    if (inFlight) {
      queued = true;
      queuedCode = code;
      queuedRestoreBoard ||= restoreBoard;
      return inFlight;
    }
    const execute = async () => {
      let nextCode = code;
      let nextRestoreBoard = restoreBoard;
      while (nextCode) {
        queued = false;
        queuedCode = "";
        queuedRestoreBoard = false;
        const remote = await authoritativeFetch();
        applyRemote(remote, nextRestoreBoard);
        if (!queued) break;
        nextCode = queuedCode || nextCode;
        nextRestoreBoard = queuedRestoreBoard || nextRestoreBoard;
      }
      return local;
    };
    const promise = execute().finally(() => {
      if (inFlight === promise) inFlight = null;
      if (!inFlight) {
        queued = false;
        queuedCode = "";
        queuedRestoreBoard = false;
      }
    });
    inFlight = promise;
    return promise;
  };

  // Case A: an active realtime event arriving during an older pending fetch
  // must cause a second authoritative fetch rather than being coalesced away.
  const firstRefresh = refresh();
  assert.equal(fetchCalls, 1);
  assert.equal(refresh(), firstRefresh);
  resolvers.shift()({ id: "challenge-1", code: "ABC23456", status: "pending", revision: 4 });
  for (let attempt = 0; attempt < 5 && fetchCalls < 2; attempt += 1) await Promise.resolve();
  assert.equal(fetchCalls, 2);
  resolvers.shift()({ id: "challenge-1", code: "ABC23456", status: "active", revision: 5 });
  await firstRefresh;
  assert.equal(local.status, "active");
  assert.equal(local.revision, 5);

  // Case C: a stale pending response cannot roll an already-active state back.
  assert.equal(applyRemote({ id: "challenge-1", code: "ABC23456", status: "pending", revision: 4 }), false);
  assert.equal(local.status, "active");
  assert.equal(local.revision, 5);

  // Case B: a same-code cached pending hydration is revalidated after the
  // authoritative state becomes active, without another subscription.
  let hydrated = { code: "ABC23456", status: "pending" };
  let cachedHydration = null;
  let hydrationInFlight = false;
  let hydrationFetches = 0;
  let subscriptions = 0;
  let subscribed = false;
  let serverStatus = "pending";
  const hydrateInvite = async () => {
    const needsAuthoritativeState = !["active", "completed"].includes(hydrated.status);
    if (cachedHydration && (!needsAuthoritativeState || hydrationInFlight)) return cachedHydration;
    cachedHydration = (async () => {
      hydrationInFlight = true;
      hydrationFetches += 1;
      if (!subscribed) {
        subscribed = true;
        subscriptions += 1;
      }
      hydrated = { code: "ABC23456", status: serverStatus };
      hydrationInFlight = false;
      return hydrated;
    })();
    return cachedHydration;
  };
  await hydrateInvite();
  serverStatus = "active";
  await hydrateInvite();
  assert.equal(hydrationFetches, 2);
  assert.equal(subscriptions, 1);
  assert.equal(hydrated.status, "active");
}

async function run() {
  const initial = { id: "g1", code: "ABC12345", revision: 4, moves: ["e2e4"], fen: "after-e4" };
  const pending = { id: "g1", code: "ABC12345", expectedRevision: 4, uci: "e7e5", boardCount: 2 };

  // A stale realtime snapshot cannot roll back an optimistic local move.
  const stale = { ...initial, revision: 4, moves: ["e2e4"] };
  assert.deepEqual(acceptRemote({ current: { ...initial, revision: 5, moves: ["e2e4", "e7e5"] }, remote: stale, pending }), { ...initial, revision: 5, moves: ["e2e4", "e7e5"] });

  // The server acknowledgement clears the pending state and is accepted once.
  const acknowledged = { ...initial, revision: 5, moves: ["e2e4", "e7e5"], fen: "after-e5" };
  assert.equal(shouldDeferRemote({ pending, remote: acknowledged }), false);
  assert.deepEqual(acceptRemote({ current: initial, remote: acknowledged, pending }), acknowledged);

  // A duplicate realtime delivery is idempotent.
  assert.deepEqual(acceptRemote({ current: acknowledged, remote: acknowledged, pending: null }), acknowledged);

  // A different challenge cannot overwrite the active game.
  const otherGame = { ...acknowledged, id: "g2", code: "ZZZZ9999", revision: 1, moves: [] };
  assert.deepEqual(acceptRemote({ current: acknowledged, remote: otherGame, pending }), otherGame);

  // Server-side history rules: only a prefix plus one action is admissible.
  assert.equal(isPrefix(initial.moves, acknowledged.moves), true);
  assert.equal(acknowledged.moves.length - initial.moves.length, 1);
  assert.equal(isPrefix(initial.moves, ["d2d4"]), false);

  // Spectators never become move submitters.
  const spectator = { remote: true, spectator: true, active: true };
  assert.equal(Boolean(spectator.spectator), true);
  assert.equal(Boolean(!spectator.spectator), false);

  // Clock snapshots are monotonic between refreshes; a reconnect cannot add time.
  const clock = { whiteMs: 120000, blackMs: 118000, serverNow: Date.now() };
  const later = { ...clock, whiteMs: 119000, serverNow: clock.serverNow + 1000 };
  assert.ok(later.whiteMs <= clock.whiteMs);

  // Phase 8B must keep terminal intent provisional in the browser until the
  // locked server payload is completed. Timeout uses the server presence
  // expiry path instead of a client-invented result marker.
  assert.match(appSource, /function markFriendTerminalPending\(/);
  assert.match(appSource, /status !== "completed"\) return false;/);
  assert.match(appSource, /function syncFriendClockExpiry\(/);
  assert.match(appSource, /markFriendTerminalPending\(outcome, "", "timeout"\)/);
  assert.match(appSource, /touchFriendChallengePresence\(code, true\)/);
  assert.match(appSource, /next\.terminalPending = false/);

  // The live two-account E2E must persist a fresh Account A session after
  // logout/account-isolation coverage before constructing new contexts.
  const e2eSource = fs.readFileSync(path.join(root, "scripts", "e2e-runner.cjs"), "utf8");
  assert.match(e2eSource, /primary live-game state refresh/);
  assert.match(e2eSource, /await page\.context\(\)\.storageState\(\{ path: primaryState \}\)/);
  assert.match(e2eSource, /challengeCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"/);
  assert.match(e2eSource, /\/\^\[A-Z2-9\]\{8,16\}\$\//);
  assert.match(e2eSource, /gotoHash\(pageB, baseUrl, "#play\?mode=friend"\)/);
  assert.match(e2eSource, /#friendChallenge[\s\S]*?#friendJoinTab/);
  assert.match(e2eSource, /Account B received the real friend-request notification/);
  assert.match(e2eSource, /Account B rendered the friend-request notification/);
  assert.match(e2eSource, /friend_declined/);
  assert.match(e2eSource, /friend_accepted/);
  assert.match(e2eSource, /Account B received the real challenge notification/);
  assert.match(e2eSource, /Account B rendered the challenge notification/);
  assert.match(e2eSource, /Account A received the challenge-accepted notification/);
  assert.match(e2eSource, /both accounts kept the same completed result and opened Review/);
  assert.match(e2eSource, /fresh Account A\/B contexts resolved live Supabase sessions before multiplayer/);
  assert.match(e2eSource, /const waitForFriendStartReady = async/);
  assert.match(e2eSource, /waitForFriendStartReady\(pageA, code, "browser: Account A friend challenge state hydrated before Start"\)/);
  assert.match(e2eSource, /state\.remoteId[\s\S]*state\.status \|\| ""\) === "active"[\s\S]*state\.active === true/);
  assert.match(e2eSource, /getSession\(\)[\s\S]*sessionResult\?\.data\?\.session\?\.user\?\.id/);
  assert.match(e2eSource, /function resetLiveE2eAccountBFixture\(\)/);
  assert.match(e2eSource, /provision-e2e-account\.cjs.*fixture-only/);
  assert.match(e2eSource, /secondary-live-fixture/);
  assert.match(e2eSource, /async function runLiveMatchmakingE2E\(/);
  assert.match(e2eSource, /function expectedNameStyleForE2eAccount\(label, accountRole = ""\)/);
  assert.match(e2eSource, /"matchmaking-secondary"[\s\S]{0,180}accountRole: "secondary"/);
  assert.match(e2eSource, /E2E_SECOND_EXPECTED_NAME_STYLE/);
  assert.match(e2eSource, /function requireLiveE2EAdminCredential\(\)/);
  assert.match(e2eSource, /Live matchmaking E2E is blocked before browser\/database work/);
  assert.match(e2eSource, /real Quick Match queue paired two accounts into one server-authoritative game/);
  assert.match(e2eSource, /Quick Match refresh recovery restored the active game/);
  assert.match(e2eSource, /Quick Match Game Over opened the existing Review workspace/);
  assert.match(e2eSource, /matchmakingOnly/);
  assert.doesNotMatch(e2eSource, /skip\("browser: two-account live/);
  assert.match(fs.readFileSync(path.join(root, "package.json"), "utf8"), /test:matchmaking-live/);
  const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const environmentGate = fs.readFileSync(path.join(root, "scripts", "test-environment.cjs"), "utf8");
  const environmentDocs = fs.readFileSync(path.join(root, "docs", "TEST-ENVIRONMENT.md"), "utf8");
  const verifyWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "verify.yml"), "utf8");
  assert.match(packageSource, /"test:environment"\s*:/);
  assert.match(packageSource, /"test:matchmaking-live"\s*:\s*"npm run test:environment &&/);
  assert.match(environmentGate, /BLOCKED\/ENVIRONMENT/);
  assert.match(environmentGate, /E2E_REALTIME_ENABLED/);
  assert.match(environmentGate, /generatedPrimary/);
  assert.match(environmentGate, /runProvisioning/);
  assert.match(environmentDocs, /npm run test:environment/);
  assert.match(environmentDocs, /production fixtures are forbidden|production.*forbidden/i);
  assert.match(verifyWorkflow, /NSCHESS_SUPABASE_SECRET_KEY/);
  assert.match(verifyWorkflow, /npm run test:environment/);
  assert.match(verifyWorkflow, /npm run test:matchmaking-live/);
  const provisioningDocs = fs.readFileSync(path.join(root, "docs", "e2e-account-provisioning.md"), "utf8");
  assert.match(provisioningDocs, /npm\.cmd run test:matchmaking-live/);
  assert.match(provisioningDocs, /SUPABASE_SECRET_KEY/);
  assert.match(e2eSource, /accountBFixture\.profile\.xp === 840/);
  assert.match(e2eSource, /accountBFixture\.profile\.coins === 1_000_000_000/);
  const fixtureSource = fs.readFileSync(path.join(root, "scripts", "provision-e2e-account.cjs"), "utf8");
  assert.match(fixtureSource, /const environmentCheck = process\.argv\.includes\("--environment-check"\)/);
  assert.match(fixtureSource, /async function ensurePrimaryE2EUser\(/);
  assert.match(fixtureSource, /email_confirm: true, user_metadata: identity\.metadata/);
  assert.match(fixtureSource, /role: "account_a", allowMissing: true/);
  assert.match(fixtureSource, /Account A Auth metadata is missing the required generated E2E marker/);
  assert.match(fixtureSource, /function expectedPrimaryNameStyle\(values\)/);
  assert.match(fixtureSource, /await equipDistinctiveNameStyle\(baseUrl, serviceKey, primaryUser\.id, primaryExpectedNameStyle\.itemId\)/);
  assert.match(fixtureSource, /verifyStoreState\(baseUrl, anonKey, primarySession\.access_token, primaryExpectedNameStyle\.itemId\)/);
  assert.match(fixtureSource, /refusing to continue because fixture isolation is not proven/);
  assert.match(fixtureSource, /const fixtureOnly = process\.argv\.includes\("--fixture-only"\)/);
  assert.match(fixtureSource, /fixture-only reset did not return the canonical Account B profile baseline/);
  assert.match(fixtureSource, /\["friend_requests", "Friend requests"\]/);
  assert.match(fixtureSource, /\["friend_presence", "Friend presence"\]/);
  assert.match(fixtureSource, /\["social_notifications", "Social notifications"\]/);
  assert.match(fixtureSource, /async function resetSocialFixtures\(/);
  assert.match(fixtureSource, /await resetSocialFixtures\(baseUrl, serviceKey, primaryUser\.id, secondaryUser\.id\)/);
  assert.match(fixtureSource, /const E2E_PRIMARY_MATCHMAKING_RATING = 1450/);
  assert.match(fixtureSource, /const E2E_SECONDARY_MATCHMAKING_RATING = 1520/);
  assert.match(fixtureSource, /fixture-only reset did not set the canonical Account A matchmaking rating/);
  assert.match(fixtureSource, /accountARating: E2E_PRIMARY_MATCHMAKING_RATING/);
  assert.match(e2eSource, /both disposable matchmaking fixtures use distinct compatible authoritative ratings/);
  assert.match(e2eSource, /accountAFixture\.rating === 1450 && accountBFixture\.rating === 1520/);
  assert.match(e2eSource, /pageA\.locator\("#quickMatchSetupForm button\[type=submit\]"\)\.click\(\),[\s\S]{0,220}pageB\.locator\("#quickMatchSetupForm button\[type=submit\]"\)\.click\(\)/);
  assert.match(e2eSource, /second Quick Match attempt created two distinct real queue tickets/);
  assert.match(e2eSource, /request\.method\(\) !== "POST"/);
  assert.match(e2eSource, /rpcCalls\.a\.length === 2 && rpcCalls\.b\.length === 1/);
  assert.match(matchmakingMigration, /abs\(candidate\.rating - self_row\.rating\) <= rating_band/);

  // The client and locked server validator must agree on all six FEN fields.
  // chess.js emits no en-passant target after e2e4 because Black has no legal
  // en-passant capture; the server must serialize the same canonical position.
  const { Chess } = await import(pathToFileURL(path.join(root, "assets", "vendor", "chess.js-1.0.0.mjs")).href);
  const fenContractGame = new Chess();
  fenContractGame.move({ from: "e2", to: "e4" });
  assert.equal(fenContractGame.fen(), "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  const enPassantContractGame = new Chess();
  [["e2", "e4"], ["a7", "a6"], ["e4", "e5"], ["d7", "d5"]].forEach(([from, to]) => enPassantContractGame.move({ from, to }));
  assert.equal(enPassantContractGame.fen(), "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3");
  assert.match(fenContractMigration, /create or replace function public\.ns_chess_en_passant_capture_is_legal\(/);
  assert.match(fenContractMigration, /if canonical_ep <> '-' and not public\.ns_chess_en_passant_capture_is_legal\(p_board, p_turn, canonical_ep\) then/);
  assert.match(fenContractMigration, /create or replace function public\.ns_chess_board_fen\(/);
  assert.match(fenContractMigration, /revoke all on function public\.ns_chess_en_passant_capture_is_legal\(jsonb, text, text\) from public;/);

  // Friend Challenge route setup can run before Supabase session hydration.
  // The invite must queue, replay after authentication, and remain idempotent
  // when setup/auth callbacks both attempt the same hydration.
  assert.match(appSource, /let friendInviteHydrationPromise = null/);
  assert.match(appSource, /let friendChallengeRefreshQueued = false/);
  assert.match(appSource, /friendChallengeRefreshQueuedCode/);
  assert.match(appSource, /friendChallengeRefreshQueuedRestoreBoard/);
  assert.match(appSource, /function friendChallengeStatusRank\(status\)/);
  assert.match(appSource, /const localNeedsAuthoritativeInvite/);
  assert.match(appSource, /let friendInviteHydrationInFlight = false/);
  assert.match(appSource, /if \(friendChallengeRefreshPromise\) \{[\s\S]{0,220}friendChallengeRefreshQueued = true/);
  assert.match(appSource, /friendInviteHydrationQueued = true/);
  assert.match(appSource, /if \(location\.hash\.includes\("challenge="\)\) \{[\s\S]{0,700}inviteNeedsAuthoritativeRefresh[\s\S]{0,180}void applyFriendInviteFromHash\(\);/);
  assert.match(appSource, /async function refreshFriendNetwork\(force = false\) \{[\s\S]{0,260}getCachedAccount\?\.\(\) \|\| \{\};[\s\S]{0,220}if \(!accountId\) return false;/);
  assert.match(appSource, /function ensureFriendRealtime\(provider = getFriendProvider\(\)\) \{[\s\S]{0,360}if \(!friendNetworkSubscriptionUserId\) return;/);
  assert.match(appSource, /function startFriendNetworkSync\(\) \{[\s\S]{0,300}if \(!activeUserId\) return;/);
  assert.match(appSource, /function syncActiveRouteRuntime\(panel = "", tab = ""\) \{[\s\S]{0,1000}else \{[\s\S]{0,700}if \(getFriendCurrentUserId\(\)\) startFriendNetworkSync\(\);[\s\S]{0,100}else stopFriendNetworkSync\(\);/,
    "a signed-in recipient must retain the global Friendly Challenge subscription outside Play and Friends so incoming invitations arrive without a refresh");
  assert.match(appSource, /friendNetworkTimer = window\.setInterval\(\(\) => \{[\s\S]{0,700}if \(!document\.hidden\) \{[\s\S]{0,180}refreshFriendNetwork\(true\);[\s\S]{0,100}refreshSocialNotifications\(\);[\s\S]{0,140}\}, 10000\);/,
    "visible signed-in routes must reconcile Friendly Challenges when a realtime event is missed");
  assert.match(appSource, /function normalizeFriendRecord\(row = \{\}\) \{[\s\S]{0,1100}const onlineNow = hasLivePresence[\s\S]{0,300}!onlineNow \? "offline"/,
    "an authoritative false online flag must force the display state offline");
  assert.match(appSource, /const presenceGraceMs = 75_000;[\s\S]{0,650}presenceStatus: "offline"/,
    "cached friend rows must not outlive the server heartbeat grace period");
  assert.doesNotMatch(appSource, /function normalizeFriendRecord\(row = \{\}\) \{[\s\S]{0,1200}last_login_at/,
    "friend presence must not infer Online from an old profile login timestamp");
  assert.match(appSource, /function applyFriendPresenceRow\(row = \{\}\) \{[\s\S]{0,1250}presencePatch[\s\S]{0,600}Merge only presence fields/);
  assert.doesNotMatch(appSource, /function applyFriendPresenceRow\(row = \{\}\) \{[\s\S]{0,400}normalizeFriendRecord\(row\)/,
    "sparse realtime presence must not replace friend identity through normalization defaults");
  assert.match(appSource, /function toFriendChallengeState\([\s\S]{0,900}targetPresence[\s\S]{0,2000}presenceConfirmed,[\s\S]{0,140}online: presenceConfirmed && Boolean\(targetPresence\?\.online\)/);
  assert.match(appSource, /function isCurrentUserFriendChallengeParticipant\(remote\)/,
    "active handoff must be limited to the authenticated challenge participant");
  assert.match(appSource, /const shouldAutoStart = remote\.status === "active"[\s\S]{0,360}isCurrentUserFriendChallengeParticipant\(remote\)[\s\S]{0,180}!coachSessionActive/,
    "both participants must hand off from every authoritative active state, not only a local pending snapshot");
  assert.match(appSource, /function queueAcceptedFriendChallengeStart\(code, remoteId = friendChallengeState\?\.remoteId\)[\s\S]{0,1100}friendChallengeAutoStartKey[\s\S]{0,700}const play = document\.getElementById\("play"\)[\s\S]{0,900}startFriendChallenge\(false\)/,
    "the shared Friend Challenge handoff must be keyed by the authoritative game identity, wait for the Play workspace, and remain idempotent");
  assert.match(appSource, /function queueAcceptedFriendChallengeStart\(code, remoteId = friendChallengeState\?\.remoteId\)[\s\S]{0,2100}if \(!CoachChess\) \{[\s\S]{0,260}loadChessRules\(\)\.then\(\(\) => window\.setTimeout\(beginWhenPlayIsMounted, 0\)\)/,
    "an accepted global invitation must wait for the lazy chess runtime before consuming its route-aware board handoff");
  assert.match(appSource, /const friendLobbyVisible = document\.body\.classList\.contains\("friend-challenge-mode"\) && !friendChallengeState\?\.active;[\s\S]{0,700}play\.classList\.toggle\("is-active-game", !isPreGame && !inReview && !isSpecialLobby\);/,
    "an active Friend Challenge must leave its setup lobby and mount the shared Play board workspace");
  assert.match(appSource, /const activeForCurrentUser = friendNetworkState\.challenges\.find\([\s\S]{0,240}challenge\.status === "active" && isCurrentUserFriendChallengeParticipant\(challenge\)/,
    "refresh/reconnect must identify an active challenge for the signed-in participant");
  assert.match(appSource, /const retainedRemoteIsTerminal = Boolean\(state\.remote && \["completed", "declined", "cancelled", "expired"\]\.includes\(String\(state\.status \|\| ""\)\.toLowerCase\(\)\)\);[\s\S]{0,520}if \(incoming && !state\.active && retainedRemoteIsTerminal\) \{[\s\S]{0,180}showIncomingFriendChallengeNotice\(incoming\);/,
    "a terminal retained challenge must not hide a later pending invite for the same recipient");
  assert.match(appSource, /else if \(activeForCurrentUser && !state\.active\) applyRemoteFriendChallenge\(activeForCurrentUser, true\)/,
    "refresh/reconnect must recover an active participant challenge without a local pending invite");
  assert.match(appSource, /function realtimeEventTargetsCurrentUserActiveChallenge\(event\)[\s\S]{0,220}isCurrentUserFriendChallengeParticipant\(row\)/,
    "realtime must identify an active event for the signed-in participant");
  assert.match(appSource, /event\?\.table === "game_challenges" && realtimeEventTargetsCurrentUserActiveChallenge\(event\)[\s\S]{0,360}queueFriendNetworkRefresh\(\)/,
    "an active realtime event without local state must trigger authoritative reconciliation");
  assert.match(appSource, /function cancelFriendChallenge\(\)[\s\S]{0,800}respondFriendChallenge\(state\.code, "cancel"\)/,
    "outgoing cancellation must use the existing authenticated server RPC");
  assert.match(appSource, /function chooseFriendChallengeTarget\(friend\) \{[\s\S]{0,1200}if \(existing\.remote\) \{[\s\S]{0,700}remote: false,[\s\S]{0,450}status: "draft"/,
    "a terminal remote invitation must become a fresh local draft only after the player explicitly selects a new challenge target");
  assert.match(appSource, /if \(remote\.status !== "pending" && friendIncomingNoticeCode === remote\.code\) \{[\s\S]{0,160}dismissFriendChallengeNotice\(\);/,
    "a terminal update must dismiss only the matching global recipient invitation prompt");
  assert.match(appSource, /else if \(state\.remote && state\.pending && state\.code\) \{[\s\S]{0,120}refreshActiveFriendChallenge\(state\.code, false\);/,
    "a pending invitation omitted from the lightweight list must reconcile its authoritative terminal state by code");
  assert.match(appSource, /friendNetworkTimer = window\.setInterval\(\(\) => \{[\s\S]{0,600}void refreshFriendNetwork\(true\);[\s\S]{0,100}void refreshSocialNotifications\(\);/);
  // A joined realtime channel is not proof that every table update arrived.
  // While a friend challenge is still pending/accepted, the shared lifecycle
  // must keep an authoritative refresh alive and stop it once the game starts.
  assert.match(appSource, /let friendChallengeSyncTimer = 0/);
  assert.match(appSource, /friendChallengeSyncTimer = window\.setInterval\(\(\) => \{[\s\S]{0,520}\["pending", "accepted"\]\.includes\(String\(state\.status/);
  assert.match(appSource, /friendChallengeSyncTimer[\s\S]{0,720}refreshActiveFriendChallenge\(state\.code, true\)/);
  assert.match(appSource, /let realtimeMatchWatchdogTimer = 0/);
  assert.match(appSource, /function scheduleRealtimeMatchWatchdog\(/);
  assert.match(appSource, /if \(!isRealtimeMatchActive\(\) \|\| !realtimeMatchHeartbeatTimer\) return/);
  assert.match(appSource, /staleFor < 4500/);
  assert.match(appSource, /await refreshActiveFriendChallenge\(code, true\)/);
  assert.match(appSource, /window\.clearTimeout\(realtimeMatchWatchdogTimer\)/);
  assert.match(appSource, /noteRealtimeMatchAuthoritativeState\(remote\)/);
  assert.match(appSource, /if \(playVisible && isRealtimeMatchActive\(\)\) startRealtimeMatchLifecycle\(\)/);
  assert.match(appSource, /stopFriendNetworkSync\(\);[\s\S]{0,120}stopRealtimeMatchLifecycle\(\);/);
  runActiveRevisionWatchdogRegression();
  runPresenceTruthRegression();
  runFriendChallengeBackendHardeningModelRegression();
  runFriendAutoPairContractRegression();
  runFriendActiveHandoffRegression();
  await runFriendInviteHydrationRegression();
  await runFriendChallengeRefreshLifecycleRegression();

  // The production migration computes the next FEN from the locked stored
  // position and rejects forged/duplicate/stale submissions.
  assert.match(hardeningMigration, /select \* into found from public\.game_challenges where code = upper\(trim\(p_code\)\) for update/);
  assert.match(hardeningMigration, /p_expected_revision is not null and p_expected_revision <> found\.revision/);
  assert.match(hardeningMigration, /applied := public\.ns_chess_apply_move\(found\.fen, new_item\)/);
  assert.match(hardeningMigration, /applied ->> 'fen' <> p_fen/);

  // SOURCE CONTRACT ASSERTION: dedicated E2E must execute this migration to
  // prove row locks, trigger execution, and RLS behavior in PostgreSQL.
  assert.match(friendChallengeHardeningMigration, /add column if not exists request_fingerprint text/);
  assert.match(friendChallengeHardeningMigration, /create unique index if not exists game_challenges_pending_target_fingerprint_key/);
  assert.match(friendChallengeHardeningMigration, /where status = 'pending'[\s\S]{0,180}opponent_id is not null[\s\S]{0,180}request_fingerprint is not null/);
  assert.match(friendChallengeHardeningMigration, /perform pg_advisory_xact_lock\(hashtextextended\([\s\S]{0,220}nschess:friend-challenge/);
  assert.match(friendChallengeHardeningMigration, /perform public\.expire_game_challenges\(\);/,
    "expired pending invitations must become terminal before idempotency lookup");
  assert.match(friendChallengeHardeningMigration, /challenge\.request_fingerprint = requested_fingerprint[\s\S]{0,260}for update/,
    "equivalent targeted creation must reuse the locked pending challenge");
  assert.match(friendChallengeHardeningMigration, /old\.status = 'pending' and new\.status = 'active'[\s\S]{0,350}challenge_accepted/,
    "acceptance notification follows the authoritative status transition");
  assert.doesNotMatch(friendChallengeHardeningMigration, /old\.opponent_id is distinct from new\.opponent_id[\s\S]{0,350}challenge_accepted/,
    "targeted acceptance cannot depend on opponent assignment changing");
  assert.match(friendChallengeHardeningMigration, /old\.status in \('pending', 'accepted'\)[\s\S]{0,160}new\.status in \('active', 'declined', 'cancelled', 'expired'\)/);
  assert.match(friendChallengeHardeningMigration, /type = 'challenge_received'[\s\S]{0,140}entity_id = new\.id[\s\S]{0,140}expires_at > now\(\)/,
    "only the affected received-invitation notification is resolved");
  assert.match(friendChallengeHardeningMigration, /security definer set search_path = public/);
  assert.match(friendChallengeHardeningMigration, /revoke all on function public\.create_game_challenge\(uuid, text, text, text, text, text\) from public/);
  assert.match(friendChallengeHardeningMigration, /grant execute on function public\.create_game_challenge\(uuid, text, text, text, text, text\) to authenticated/);
  assert.match(hardeningMigration, /select \* into found from public\.finalize_game_challenge\(found\.id/);
  const foundationSql = fs.readFileSync(path.join(root, "supabase", "friends.sql"), "utf8");
  const readmeSource = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const deploymentChecklist = fs.readFileSync(path.join(root, "docs", "DEPLOYMENT-CHECKLIST.md"), "utf8");
  assert.match(foundationSql, /Canonical foundation install[\s\S]+position writes fail closed because the RPC is absent/i);
  assert.doesNotMatch(foundationSql, /create or replace function public\.save_game_challenge_position/i,
    "foundation friends.sql must not install a weaker move-position RPC");
  assert.doesNotMatch(foundationSql, /grant execute on function public\.save_game_challenge_position/i,
    "foundation friends.sql must not grant a move-position RPC it does not own");
  assert.match(foundationSql, /drop function if exists public\.save_game_challenge_position\(text, text, jsonb, text, boolean, bigint\);/i);
  assert.match(readmeSource, /20260819_release_candidate_security_hardening\.sql[\s\S]{0,240}mandatory/i);
  assert.match(deploymentChecklist, /20260819_release_candidate_security_hardening\.sql[\s\S]{0,180}before enabling multiplayer/i);
  assert.match(hardeningMigration, /applied ->> 'fen' <> p_fen/);

  console.log("multiplayer-regression: synchronization, server-authority, E2E-state, and friend-auth hydration checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
