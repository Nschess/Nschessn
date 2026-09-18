/*
 * Manual-only dedicated-E2E acceptance for Friendly Challenge hardening.
 *
 * Run this only from the already credentialed server-side shell after
 * `npm.cmd run test:environment` succeeds. It never reads a privileged key
 * from .env.e2e and refuses every target except the reviewed E2E project.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseEnvFile, assertApprovedE2EProject } = require("./e2e-config.cjs");
const { loadPublicEnvironment, requiredConfiguration } = require("./test-environment.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");
const expectedProjectRef = "aecmlskxvhosslnbebui";
const forbiddenProductionRef = "jfrvoykwowzthlvzwsmi";
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const results = new Map();
const createdChallenges = new Map();
let cleanupContext = null;
let temporaryThird = null;

function print(label, value, detail = "") {
  results.set(label, value);
  console.log(`${label}: ${value}${detail ? ` — ${detail}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  throw new Error(`Friendly Challenge live acceptance blocked: ${message}`);
}

function isUnavailableFixtureCapability(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [401, 403, 404].includes(Number(error?.status))
    || /permission denied|not authorized|does not exist|not found|schema cache/.test(message);
}

function loadPublicValues() {
  const values = fs.existsSync(envFile) ? parseEnvFile(envFile) : {};
  for (const [key, value] of Object.entries(values)) {
    if (["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"].includes(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

function resolveAdminCredential() {
  const secret = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (secret) return secret;
  const legacy = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (legacy) return legacy;
  return "";
}

function isModernSecret(key) {
  return /^sb_secret_/i.test(String(key || ""));
}

async function requestJson(url, key, options = {}) {
  const { admin = false, ...fetchOptions } = options;
  const headers = {
    apikey: admin ? key : String(process.env.E2E_SUPABASE_ANON_KEY || ""),
    Accept: "application/json",
    ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
    ...(fetchOptions.headers || {})
  };
  if (!admin || !isModernSecret(key)) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(url, {
    ...fetchOptions,
    headers
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(String(body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${response.status}`));
    error.status = response.status;
    error.code = body?.code || body?.error_code || "";
    throw error;
  }
  return body;
}

function rpc(baseUrl, token, name, payload) {
  return requestJson(`${baseUrl}/rest/v1/rpc/${name}`, token, {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
}

function adminRest(baseUrl, adminKey, table, query = "", options = {}) {
  return requestJson(`${baseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`, adminKey, { admin: true, ...options });
}

function adminRpc(baseUrl, adminKey, name, payload = {}) {
  return requestJson(`${baseUrl}/rest/v1/rpc/${name}`, adminKey, {
    admin: true,
    method: "POST",
    body: JSON.stringify(payload)
  });
}

function challengeCode() {
  const bytes = crypto.randomBytes(10);
  return [...bytes].map((byte) => codeAlphabet[byte % codeAlphabet.length]).join("");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function signIn(baseUrl, email, password) {
  const result = await requestJson(`${baseUrl}/auth/v1/token?grant_type=password`, String(process.env.E2E_SUPABASE_ANON_KEY || ""), {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  const token = String(result?.access_token || "");
  const id = String(result?.user?.id || "");
  assert(token && id, "the disposable account did not receive an authenticated session");
  return { token, id };
}

async function getChallenge(baseUrl, session, code) {
  return rpc(baseUrl, session.token, "get_game_challenge", { p_code: code });
}

async function createChallenge(baseUrl, session, targetId, config = {}) {
  const payload = {
    p_target_id: targetId,
    p_code: config.code || challengeCode(),
    p_invite_type: config.inviteType || "private",
    p_game_type: config.gameType || "casual",
    p_color: config.color || "random",
    p_clock: config.clock || "5+0"
  };
  const created = await rpc(baseUrl, session.token, "create_game_challenge", payload);
  assert(created?.id && created?.status === "pending", "targeted create did not return an authoritative pending challenge");
  createdChallenges.set(String(created.id), { code: String(created.code), creatorId: session.id, opponentId: targetId });
  return created;
}

async function readChallengeRows(baseUrl, adminKey, code) {
  return asArray(await adminRest(baseUrl, adminKey, "game_challenges",
    `code=eq.${encodeURIComponent(code)}&select=id,code,creator_id,opponent_id,status,game_type,creator_color,clock,fen,revision,request_fingerprint,expires_at,updated_at&limit=10`));
}

async function notificationRows(baseUrl, adminKey, recipientId, challengeId, type) {
  return asArray(await adminRest(baseUrl, adminKey, "social_notifications",
    `recipient_id=eq.${encodeURIComponent(recipientId)}&entity_id=eq.${encodeURIComponent(challengeId)}&type=eq.${encodeURIComponent(type)}&select=id,recipient_id,actor_id,type,entity_id,entity_code,read_at,expires_at,created_at&order=created_at.asc`));
}

function isResolved(note) {
  return Boolean(note?.read_at) && Date.parse(String(note?.expires_at || "")) <= Date.now();
}

async function activeNotifications(baseUrl, session) {
  return asArray(await rpc(baseUrl, session.token, "get_social_notifications", { p_limit: 100 }));
}

async function ensureFriendship(baseUrl, a, b) {
  const directory = asArray(await rpc(baseUrl, a.token, "get_friend_directory", {}));
  const relationship = directory.find((row) => String(row?.public_id || "") === b.id);
  if (String(relationship?.request_status || "") === "accepted") return;
  await rpc(baseUrl, a.token, "send_friend_request", { target_user: b.id });
  const afterSend = asArray(await rpc(baseUrl, a.token, "get_friend_directory", {}));
  if (afterSend.some((row) => String(row?.public_id || "") === b.id && String(row?.request_status || "") === "accepted")) return;
  const incomingDirectory = asArray(await rpc(baseUrl, b.token, "get_friend_directory", {}));
  const incoming = incomingDirectory.find((row) => String(row?.public_id || "") === a.id && String(row?.request_status || "") === "pending");
  assert(incoming?.request_id, "the disposable friend request was not available for B to accept");
  await rpc(baseUrl, b.token, "respond_to_friend_request", { request_id: incoming.request_id, accept_request: true });
}

async function expectReject(operation, label) {
  try {
    await operation();
  } catch {
    print(label, "PASS");
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function assertNoDuplicateAccepted(baseUrl, adminKey, challengerId, challengeId) {
  const accepted = await notificationRows(baseUrl, adminKey, challengerId, challengeId, "challenge_accepted");
  assert(accepted.length === 1, `expected exactly one accepted notification, found ${accepted.length}`);
  return accepted;
}

async function assertReceivedResolved(baseUrl, adminKey, recipientId, challengeId, recipientSession) {
  const rows = await notificationRows(baseUrl, adminKey, recipientId, challengeId, "challenge_received");
  assert(rows.length === 1 && isResolved(rows[0]), "the matching received notification was not marked read and expired");
  const visible = await activeNotifications(baseUrl, recipientSession);
  assert(!visible.some((note) => String(note?.entity_id || note?.entityId || "") === challengeId && note?.type === "challenge_received"),
    "the resolved received notification remained actionable in the recipient feed");
}

async function ensureNoForeignChildren(baseUrl, adminKey, challenge, aId, bId) {
  for (const [table, owner] of [["game_challenge_messages", "user_id"], ["game_challenge_presence", "user_id"], ["game_challenge_validation_events", "actor_id"]]) {
    const rows = asArray(await adminRest(baseUrl, adminKey, table,
      `challenge_id=eq.${encodeURIComponent(challenge.id)}&select=${owner}&limit=100`));
    assert(rows.every((row) => [aId, bId].includes(String(row?.[owner] || ""))),
      `refusing cleanup: ${table} contains non-fixture data for a test-created challenge`);
  }
  const tournamentRows = asArray(await adminRest(baseUrl, adminKey, "tournament_pairings",
    `challenge_id=eq.${encodeURIComponent(challenge.id)}&select=challenge_id&limit=1`));
  assert(tournamentRows.length === 0, "refusing cleanup: a test-created challenge acquired tournament linkage");
}

async function createTemporaryThird(baseUrl, adminKey) {
  const email = `nschess-e2e-c-${crypto.randomBytes(4).toString("hex")}@proton.me`;
  const password = `${crypto.randomBytes(24).toString("base64url")}A1!`;
  const created = await requestJson(`${baseUrl}/auth/v1/admin/users`, adminKey, {
    admin: true,
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        e2e: true,
        e2e_role: "friendly_challenge_acceptance_temp_c"
      }
    })
  });
  const id = String(created?.id || created?.user?.id || "");
  assert(id, "temporary third-party Auth user creation returned no user ID");
  const exact = await requestJson(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, adminKey, { admin: true });
  const user = exact?.user || exact;
  assert(String(user?.id || "") === id && String(user?.email || "").toLowerCase() === email,
    "temporary third-party Auth lookup did not return the exact generated identity");
  // Record only this generated ID before further validation so a later profile
  // or login failure still has an exact, safely removable cleanup target.
  temporaryThird = { id, email, password };
  assert(user?.email_confirmed_at && user?.user_metadata?.e2e === true && user?.user_metadata?.e2e_role === "friendly_challenge_acceptance_temp_c",
    "temporary third-party Auth identity was not confirmed and explicitly marked as an E2E fixture");
  const profiles = asArray(await adminRest(baseUrl, adminKey, "profiles",
    `id=eq.${encodeURIComponent(id)}&select=id&limit=1`));
  assert(profiles.length === 1 && String(profiles[0]?.id || "") === id,
    "temporary third-party profile trigger did not create the exact fixture profile");
  const session = await signIn(baseUrl, email, password);
  assert(session.id === id, "temporary third-party login did not resolve to the exact generated identity");
  return { id, token: session.token };
}

async function removeTemporaryThird(baseUrl, adminKey) {
  if (!temporaryThird) return;
  const { id } = temporaryThird;
  const [challenges, notifications, requests] = await Promise.all([
    adminRest(baseUrl, adminKey, "game_challenges", `or=(creator_id.eq.${encodeURIComponent(id)},opponent_id.eq.${encodeURIComponent(id)})&select=id&limit=1`),
    adminRest(baseUrl, adminKey, "social_notifications", `or=(recipient_id.eq.${encodeURIComponent(id)},actor_id.eq.${encodeURIComponent(id)})&select=id&limit=1`),
    adminRest(baseUrl, adminKey, "friend_requests", `or=(sender_id.eq.${encodeURIComponent(id)},receiver_id.eq.${encodeURIComponent(id)})&select=id&limit=1`)
  ]);
  assert(asArray(challenges).length === 0 && asArray(notifications).length === 0 && asArray(requests).length === 0,
    "refusing to delete the temporary third-party identity because it acquired unexpected related data");
  await requestJson(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, adminKey, {
    admin: true,
    method: "DELETE"
  });
  temporaryThird = null;
}

async function proveExpiration(baseUrl, adminKey, a, b, control) {
  try {
    const expiring = await createChallenge(baseUrl, a, b.id, { clock: "1+0", color: "w" });
    const before = (await readChallengeRows(baseUrl, adminKey, expiring.code))[0];
    assert(before?.status === "pending", "expiration fixture was not authoritatively pending");
    await adminRest(baseUrl, adminKey, "game_challenges",
      `id=eq.${encodeURIComponent(expiring.id)}&creator_id=eq.${encodeURIComponent(a.id)}&opponent_id=eq.${encodeURIComponent(b.id)}&status=eq.pending`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      });
    const lifecycle = await adminRpc(baseUrl, adminKey, "expire_game_challenges");
    assert(lifecycle !== undefined, "the authoritative expiration lifecycle returned no response");
    const expired = (await readChallengeRows(baseUrl, adminKey, expiring.code))[0];
    assert(expired?.status === "expired", "the authoritative expiration lifecycle did not expire the exact pending challenge");
    await assertReceivedResolved(baseUrl, adminKey, b.id, expiring.id, b);
    await expectReject(() => rpc(baseUrl, b.token, "respond_game_challenge", { p_code: expiring.code, p_response: "accept" }), "EXPIRED INVITE ACCEPT REJECTED");
    const preserved = (await readChallengeRows(baseUrl, adminKey, control.code))[0];
    assert(preserved?.status === "pending", "expiration lifecycle modified the unrelated valid control challenge");
    print("EXPIRATION", "PASS");
  } catch (error) {
    if (!isUnavailableFixtureCapability(error)) throw error;
    print("EXPIRATION", "BLOCKED", `authoritative expiry fixture path is unavailable: ${error.message || error}`);
  }
}

async function proveThirdPartyAuthorization(baseUrl, adminKey, a, b) {
  let third;
  try {
    third = await createTemporaryThird(baseUrl, adminKey);
  } catch (error) {
    try { await removeTemporaryThird(baseUrl, adminKey); } catch (cleanupError) {
      throw new Error(`${error.message || error}; temporary C cleanup failed: ${cleanupError.message || cleanupError}`);
    }
    print("THIRD-PARTY AUTHORIZATION", "BLOCKED", `temporary disposable C is unsupported: ${error.message || error}`);
    return;
  }
  try {
    const protectedChallenge = await createChallenge(baseUrl, a, b.id, { clock: "30+0", color: "b" });
    await expectReject(() => rpc(baseUrl, third.token, "respond_game_challenge", { p_code: protectedChallenge.code, p_response: "accept" }), "THIRD-PARTY ACCEPT REJECTED");
    await expectReject(() => rpc(baseUrl, third.token, "respond_game_challenge", { p_code: protectedChallenge.code, p_response: "decline" }), "THIRD-PARTY DECLINE REJECTED");
    await expectReject(() => rpc(baseUrl, third.token, "respond_game_challenge", { p_code: protectedChallenge.code, p_response: "cancel" }), "THIRD-PARTY CANCEL REJECTED");
    const after = (await readChallengeRows(baseUrl, adminKey, protectedChallenge.code))[0];
    assert(after?.status === "pending" && after?.creator_id === a.id && after?.opponent_id === b.id,
      "a third-party mutation changed the A/B pending challenge");
    await removeTemporaryThird(baseUrl, adminKey);
    print("THIRD-PARTY AUTHORIZATION", "PASS");
  } catch (error) {
    try { await removeTemporaryThird(baseUrl, adminKey); } catch (cleanupError) {
      throw new Error(`${error.message || error}; temporary C cleanup failed: ${cleanupError.message || cleanupError}`);
    }
    throw error;
  }
}

async function cleanup() {
  if (!cleanupContext) return;
  const { baseUrl, adminKey, a, b } = cleanupContext;
  const ids = [...createdChallenges.keys()];
  for (const id of ids) {
    const challenge = createdChallenges.get(id);
    try {
      await ensureNoForeignChildren(baseUrl, adminKey, { id }, a.id, b.id);
      await adminRest(baseUrl, adminKey, "social_notifications",
        `entity_id=eq.${encodeURIComponent(id)}&or=(recipient_id.eq.${a.id},recipient_id.eq.${b.id})`,
        { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await adminRest(baseUrl, adminKey, "game_challenges",
        `id=eq.${encodeURIComponent(id)}&creator_id=eq.${encodeURIComponent(challenge.creatorId)}&opponent_id=eq.${encodeURIComponent(challenge.opponentId)}`,
        { method: "DELETE", headers: { Prefer: "return=minimal" } });
    } catch (error) {
      console.error(`CLEANUP BLOCKED for test-created challenge ${challenge.code}: ${error.message}`);
    }
  }
  try { await rpc(baseUrl, b.token, "set_social_presence", { p_status: "online", p_connected: true }); } catch { /* non-fatal restoration */ }
  try { await removeTemporaryThird(baseUrl, adminKey); } catch (error) {
    console.error(`CLEANUP BLOCKED for temporary third-party identity: ${error.message}`);
  }
}

async function main() {
  loadPublicValues();
  const configured = requiredConfiguration(loadPublicEnvironment());
  if (configured.missing.length || configured.issues.length) fail([...configured.missing, ...configured.issues].join("; "));
  const target = assertApprovedE2EProject({ E2E_SUPABASE_URL: process.env.E2E_SUPABASE_URL, E2E_BASE_URL: process.env.E2E_BASE_URL });
  if (target.projectRef !== expectedProjectRef || target.projectRef === forbiddenProductionRef) fail("the explicit E2E target is not the dedicated Friendly Challenge project");
  const adminKey = resolveAdminCredential();
  if (!adminKey) fail("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required only in the invoking shell");
  print("TARGET PROJECT VERIFIED", "PASS", target.projectRef);

  const a = await signIn(target.url, configured.primaryEmail, configured.primaryPassword);
  const b = await signIn(target.url, configured.secondaryEmail, configured.secondaryPassword);
  assert(a.id !== b.id, "the two disposable sessions resolved to the same account");
  cleanupContext = { baseUrl: target.url, adminKey, a, b };
  await ensureFriendship(target.url, a, b);

  // A control challenge proves subsequent creates never mutate an unrelated,
  // valid fixture challenge. It is test-created and removed by exact ID.
  const control = await createChallenge(target.url, a, b.id, { clock: "10+0", color: "w" });
  const controlBefore = (await readChallengeRows(target.url, adminKey, control.code))[0];
  assert(controlBefore?.status === "pending", "control challenge did not persist");

  const initial = await createChallenge(target.url, a, b.id, { clock: "5+0", color: "w" });
  const initialRows = await readChallengeRows(target.url, adminKey, initial.code);
  assert(initialRows.length === 1 && initialRows[0].creator_id === a.id && initialRows[0].opponent_id === b.id && initialRows[0].status === "pending",
    "targeted create did not produce exactly one server-owned pending challenge");
  print("TARGETED CREATE", "PASS");
  const controlAfter = (await readChallengeRows(target.url, adminKey, control.code))[0];
  assert(controlAfter?.status === controlBefore.status && controlAfter?.revision === controlBefore.revision,
    "creating another challenge mutated the unrelated control challenge");
  print("UNRELATED CHALLENGE PRESERVED", "PASS");

  const received = await notificationRows(target.url, adminKey, b.id, initial.id, "challenge_received");
  assert(received.length === 1 && received[0].actor_id === a.id, "B did not receive exactly one persisted challenge_received notification");
  assert((await activeNotifications(target.url, b)).some((note) => String(note?.entity_id || note?.entityId || "") === initial.id && note?.type === "challenge_received"),
    "B did not receive the challenge through its authenticated notification feed");
  print("RECEIVED NOTIFICATION", "PASS");

  const accepted = await rpc(target.url, b.token, "respond_game_challenge", { p_code: initial.code, p_response: "accept" });
  assert(accepted?.id === initial.id && accepted?.status === "active", "B acceptance did not authoritatively transition the intended pending challenge to active");
  print("ACCEPT", "PASS");
  await assertNoDuplicateAccepted(target.url, adminKey, a.id, initial.id);
  print("ACCEPTED NOTIFICATION EXACTLY ONCE", "PASS");
  await assertReceivedResolved(target.url, adminKey, b.id, initial.id, b);
  print("RECEIVED NOTIFICATION RESOLVED", "PASS");

  const [activeA, activeB] = await Promise.all([getChallenge(target.url, a, initial.code), getChallenge(target.url, b, initial.code)]);
  assert(activeA?.id === activeB?.id && activeA.id === initial.id, "A and B did not resolve the same active game identity");
  assert(activeA?.fen === activeB?.fen, "A and B did not resolve the same authoritative initial FEN");
  assert(["w", "b"].includes(activeA?.creatorColor) && activeB?.creatorColor === activeA?.creatorColor,
    "the authoritative creator color was not preserved");
  const colorFor = (state, accountId) => state.creatorId === accountId
    ? state.creatorColor
    : state.creatorColor === "w" ? "b" : "w";
  assert(colorFor(activeA, a.id) !== colorFor(activeB, b.id), "the two accounts did not resolve complementary authoritative colors");
  print("SAME GAME ID", "PASS");
  print("COMPLEMENTARY COLORS", "PASS");
  print("SAME INITIAL FEN", "PASS");

  // A harmless service-owned timestamp update exercises the active-to-active
  // trigger path without inventing a chess move; no second accepted event may appear.
  await adminRest(target.url, adminKey, "game_challenges", `id=eq.${encodeURIComponent(initial.id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ updated_at: new Date().toISOString() })
  });
  await expectReject(() => rpc(target.url, b.token, "respond_game_challenge", { p_code: initial.code, p_response: "accept" }), "DUPLICATE ACCEPT");
  await assertNoDuplicateAccepted(target.url, adminKey, a.id, initial.id);

  const declined = await createChallenge(target.url, a, b.id, { clock: "3+2", color: "b" });
  await rpc(target.url, b.token, "respond_game_challenge", { p_code: declined.code, p_response: "decline" });
  assert((await readChallengeRows(target.url, adminKey, declined.code))[0]?.status === "declined", "decline did not persist a terminal status");
  await assertReceivedResolved(target.url, adminKey, b.id, declined.id, b);
  await expectReject(() => rpc(target.url, b.token, "respond_game_challenge", { p_code: declined.code, p_response: "accept" }), "DECLINE");

  const cancelled = await createChallenge(target.url, a, b.id, { clock: "15+10", color: "random" });
  await rpc(target.url, a.token, "respond_game_challenge", { p_code: cancelled.code, p_response: "cancel" });
  assert((await readChallengeRows(target.url, adminKey, cancelled.code))[0]?.status === "cancelled", "cancel did not persist a terminal status");
  await assertReceivedResolved(target.url, adminKey, b.id, cancelled.id, b);
  await expectReject(() => rpc(target.url, b.token, "respond_game_challenge", { p_code: cancelled.code, p_response: "accept" }), "CANCEL");

  const firstDuplicateCode = challengeCode();
  const secondDuplicateCode = challengeCode();
  const concurrentPayload = { inviteType: "private", gameType: "casual", color: "random", clock: "5+0" };
  const [firstDuplicate, secondDuplicate] = await Promise.all([
    createChallenge(target.url, a, b.id, { ...concurrentPayload, code: firstDuplicateCode }),
    createChallenge(target.url, a, b.id, { ...concurrentPayload, code: secondDuplicateCode })
  ]);
  assert(firstDuplicate.id === secondDuplicate.id, "concurrent equivalent creates did not reconcile to the same pending challenge");
  const duplicateRows = asArray(await adminRest(target.url, adminKey, "game_challenges",
    `creator_id=eq.${encodeURIComponent(a.id)}&opponent_id=eq.${encodeURIComponent(b.id)}&status=eq.pending&clock=eq.5%2B0&game_type=eq.casual&select=id,code,request_fingerprint&limit=100`));
  const duplicateIds = new Set(duplicateRows.filter((row) => row.request_fingerprint === duplicateRows.find((candidate) => candidate.id === firstDuplicate.id)?.request_fingerprint).map((row) => row.id));
  assert(duplicateIds.size === 1, `expected one pending equivalent challenge, found ${duplicateIds.size}`);
  print("SERVER DUPLICATE CREATE IDEMPOTENCY", "PASS");

  const different = await createChallenge(target.url, a, b.id, { clock: "10+0", color: "random" });
  assert(different.id !== firstDuplicate.id, "materially different time control was incorrectly deduplicated");
  print("NON-EQUIVALENT CREATE", "PASS");
  await rpc(target.url, a.token, "respond_game_challenge", { p_code: firstDuplicate.code, p_response: "cancel" });
  const afterTerminal = await createChallenge(target.url, a, b.id, { ...concurrentPayload, code: challengeCode() });
  assert(afterTerminal.id !== firstDuplicate.id, "terminal equivalent invite incorrectly blocked a new invite");
  print("NEW INVITE AFTER TERMINAL", "PASS");

  // A fresh B session reads the pending invite from server state, not from a
  // prior client instance. Mark B offline first and verify A's authoritative
  // directory result wins over any stale local label.
  await rpc(target.url, b.token, "set_social_presence", { p_status: "offline", p_connected: false });
  const directoryA = asArray(await rpc(target.url, a.token, "get_friend_directory", {}));
  const bDirectoryRow = directoryA.find((row) => String(row?.public_id || "") === b.id);
  assert(bDirectoryRow?.online === false, "server online=false did not override stale friend presence");
  print("FALSE ONLINE STATUS FIX", "PASS");
  const freshB = await signIn(target.url, configured.secondaryEmail, configured.secondaryPassword);
  const recovered = await getChallenge(target.url, freshB, afterTerminal.code);
  assert(recovered?.id === afterTerminal.id && recovered?.status === "pending", "a pending offline invite was not recovered from server state");
  print("OFFLINE/PERSISTED INVITE", "PASS");
  const freshA = await signIn(target.url, configured.primaryEmail, configured.primaryPassword);
  const refreshedActive = await getChallenge(target.url, freshA, initial.code);
  assert(refreshedActive?.id === initial.id && refreshedActive?.status === "active", "fresh client instances did not recover the active server challenge");
  print("REFRESH/RECONNECT", "PASS");

  await proveExpiration(target.url, adminKey, a, freshB, control);
  await proveThirdPartyAuthorization(target.url, adminKey, a, freshB);
  print("PRODUCTION UNTOUCHED", "PASS");
}

main()
  .then(() => {
    const blocked = [...results.values()].some((value) => value === "BLOCKED");
    console.log(`FINAL: FRIENDLY CHALLENGE DATABASE/API ACCEPTANCE ${blocked ? "BLOCKED" : "PASS"}`);
    if (blocked) process.exitCode = 2;
  })
  .catch((error) => {
    console.error(`FINAL: FRIENDLY CHALLENGE DATABASE/API ACCEPTANCE FAIL — ${error.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
