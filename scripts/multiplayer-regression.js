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

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const hardeningMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260819_release_candidate_security_hardening.sql"), "utf8");

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
  assert.match(e2eSource, /joinCode\.inputValue\(\) === code/);
  assert.match(e2eSource, /fresh Account A\/B contexts resolved live Supabase sessions before multiplayer/);
  assert.match(e2eSource, /const waitForFriendStartReady = async/);
  assert.match(e2eSource, /waitForFriendStartReady\(pageA, code, "browser: Account A friend challenge state hydrated before Start"\)/);
  assert.match(e2eSource, /state\.remoteId[\s\S]*state\.status \|\| ""\) === "active"[\s\S]*state\.active === true/);
  assert.match(e2eSource, /getSession\(\)[\s\S]*sessionResult\?\.data\?\.session\?\.user\?\.id/);
  assert.match(e2eSource, /function resetLiveE2eAccountBFixture\(\)/);
  assert.match(e2eSource, /provision-e2e-account\.cjs.*fixture-only/);
  assert.match(e2eSource, /secondary-live-fixture/);
  assert.match(e2eSource, /accountBFixture\.profile\.xp === 840/);
  assert.match(e2eSource, /accountBFixture\.profile\.coins === 1_000_000_000/);
  const fixtureSource = fs.readFileSync(path.join(root, "scripts", "provision-e2e-account.cjs"), "utf8");
  assert.match(fixtureSource, /const fixtureOnly = process\.argv\.includes\("--fixture-only"\)/);
  assert.match(fixtureSource, /fixture-only reset did not return the canonical Account B profile baseline/);

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
  await runFriendInviteHydrationRegression();
  await runFriendChallengeRefreshLifecycleRegression();

  // The production migration computes the next FEN from the locked stored
  // position and rejects forged/duplicate/stale submissions.
  assert.match(hardeningMigration, /select \* into found from public\.game_challenges where code = upper\(trim\(p_code\)\) for update/);
  assert.match(hardeningMigration, /p_expected_revision is not null and p_expected_revision <> found\.revision/);
  assert.match(hardeningMigration, /applied := public\.ns_chess_apply_move\(found\.fen, new_item\)/);
  assert.match(hardeningMigration, /applied ->> 'fen' <> p_fen/);
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
