/*
 * Matchmaking foundation contract checks.
 *
 * These assertions cover the queue contract and client lifecycle guards
 * without making production or E2E-account writes. Authenticated browser/API
 * proof remains part of the Stability Gate when the target Supabase project
 * is available.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8").replace(/\r\n/g, "\n");
const friendsSql = fs.readFileSync(path.join(root, "supabase", "friends.sql"), "utf8");
const baseSql = fs.readFileSync(path.join(root, "supabase", "matchmaking.sql"), "utf8");
const intelligentSql = fs.readFileSync(path.join(root, "supabase", "migrations", "20260814_intelligent_quick_match.sql"), "utf8");
const pairingSecuritySql = fs.readFileSync(path.join(root, "supabase", "migrations", "20260908_matchmaking_pairing_security.sql"), "utf8");
const ratingHardeningSql = fs.readFileSync(path.join(root, "supabase", "migrations", "20260908_matchmaking_rating_hardening.sql"), "utf8");

function includes(source, fragment, label) {
  assert.ok(source.includes(fragment), `missing matchmaking contract: ${label}`);
}

function run() {
  // Queue identity and server-authoritative pairing.
  includes(baseSql, "user_id uuid not null unique", "one active ticket per account");
  includes(baseSql, "create or replace function public.try_pair_matchmaking_queue", "server pairing function");
  includes(baseSql, "match_source", "matchmaking challenge source");
  includes(intelligentSql, "pg_advisory_xact_lock(hashtextextended('nschess:quick-match'", "serialized pairing");
  includes(intelligentSql, "for update skip locked", "atomic candidate claim");
  includes(intelligentSql, "queue_state = 'matched'", "server match state");
  includes(intelligentSql, "paired := public.try_pair_matchmaking_queue(current_user_id);", "join invokes server pairing");
  includes(intelligentSql, "if paired is not null then return paired;", "join returns a server-created pair");
  includes(intelligentSql, "insert into public.game_challenges", "pairing creates the shared game");
  includes(intelligentSql, "heartbeat_at >= now() - interval '45 seconds'", "stale queue exclusion");
  includes(intelligentSql, "create or replace function public.resolve_matchmaking_timeout", "server fallback decision");
  includes(intelligentSql, "create or replace function public.heartbeat_matchmaking_queue", "queue heartbeat");
  includes(intelligentSql, "'ratingRange', public.quick_match_rating_band", "server-owned rating range payload");
  includes(pairingSecuritySql, "auth.uid() <> p_user_id", "pairing authenticates the queue owner");
  assert.match(pairingSecuritySql, /creator_row := self_row;\s*opponent_user_row := opponent_row;/,
    "pairing uses the authenticated caller as challenge creator");
  assert.doesNotMatch(pairingSecuritySql, /if self_row\.joined_at <= opponent_row\.joined_at/,
    "pairing must not assign challenge ownership by ticket age");

  // Rated/casual, clock, and color preferences are validated server-side.
  includes(baseSql, "game_type in ('casual', 'rated')", "game type constraint");
  includes(baseSql, "preferred_color in ('w', 'b', 'random')", "color constraint");
  includes(baseSql, "clock = 'none' or clock ~", "clock constraint");
  includes(intelligentSql, "candidate.clock = self_row.clock", "time-control compatibility");
  includes(intelligentSql, "increment_value := case when creator_row.clock = 'none'", "server increment assignment");
  includes(intelligentSql, "resolve_matchmaking_creator_color", "server color assignment");
  includes(intelligentSql, "p_game_type text default 'casual'", "extended join RPC");
  includes(intelligentSql, "p_preferred_color text default 'random'", "extended color RPC");
  includes(friendsSql, "if found.game_type = 'rated' then", "casual games do not change rating");
  includes(ratingHardeningSql, "if found.game_type = 'rated' then", "existing database rating hardening migration");

  // Client cancellation must reach the authenticated server queue and wait for
  // the in-flight join to produce a ticket before the search is considered done.
  assert.match(app, /const leaveQueue = \(\) => \{[\s\S]*?leavePromise = Promise\.resolve\(provider\.leaveMatchmakingQueue\(ticketToLeave\)\)/, "idempotent server queue leave");
  assert.match(app, /const abortSearch = async \(\) => \{[\s\S]*?await leaveQueue\(\);[\s\S]*?finish\(null\);/, "abort waits for server queue leave");
  assert.match(app, /abortHandler = \(\) => \{ void abortSearch\(\); \};[\s\S]*?signal\?\.addEventListener\("abort", abortHandler/, "abort listener installed before join");
  assert.match(app, /if \(signal\?\.aborted\) \{[\s\S]*?await leaveQueue\(\);[\s\S]*?return null;[\s\S]*?if \(!ticketId\) throw new Error\("Matchmaking did not return a queue ticket\."\)/, "post-join cancellation guard");
  assert.match(app, /const closeSearch = async \(\{ restoreFocus = true \} = \{\}\) => \{[\s\S]*?await Promise\.allSettled\(\[pendingSearch, pendingOnlineSearch\]/, "UI waits for cancellation cleanup");
  assert.match(app, /await Promise\.allSettled\(\[pendingSearch, pendingOnlineSearch\][\s\S]*?mode=quick[\s\S]*?replaceState\?\.\(null, "", "#play"\)[\s\S]*?setup\.hidden = true/, "cancel returns Quick Match to ready route");
  assert.match(app, /const openSetupFromHash = \(\) => \{[\s\S]*?mode=quick[\s\S]*?setup\.hidden && overlay\.hidden[\s\S]*?openSetup\(null\);/, "Quick Match setup reopens on hash-only route entry");
  includes(app, "window.addEventListener(\"hashchange\", openSetupFromHash);", "Quick Match route reinitialization");
  assert.match(app, /stop\?\.addEventListener\("click", \(\) => \{ void closeSearch\(\); \}\)/, "Cancel Search invokes server cancellation");
  includes(app, "const { data: userData, error: userError } = await supabase.auth.getUser();", "authenticated queue RPC identity");
  includes(app, "leaveMatchmakingQueue: (ticketId) => callFriendRpc(\"leave_matchmaking_queue\", { p_ticket_id: ticketId })", "server queue-leave RPC");
  includes(intelligentSql, "current_user_id uuid := auth.uid();", "server queue-leave authenticated identity");
  includes(intelligentSql, "delete from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id", "server queue-leave account isolation");
  includes(app, "if (!ticketId) throw new Error(\"Matchmaking did not return a queue ticket.\");", "ticket requirement");
  includes(app, "provider.heartbeatMatchmakingQueue?.(ticketId)", "client queue heartbeat");
  assert.match(app, /const ratingRange = source\.ratingRange[\s\S]*?hasRatingRange:[\s\S]*?const reportStatus = \(payload\) => \{[\s\S]*?options\.onStatus\?\.\(ticket\)/,
    "client surfaces the server-owned rating range through an explicit queue-status callback");
  assert.match(app, /waitForOnlineMatch\(state\.controller\.signal, \(ticket\) => \{[\s\S]*?setMatchMeta\(state\.options, ticket\)/,
    "search metadata updates from the authenticated queue ticket rather than a fabricated rating band");
  assert.match(app, /setSearchPresentation\("AI fallback",[\s\S]*?No human match was completed/,
    "AI handoff remains visibly identified as a fallback");
  assert.doesNotMatch(
    app,
    /Searching for a human opponent\.\.\. \$\{seconds\}s|AI fallback after \$\{/,
    "search messaging must not present client-invented timing as a queue estimate"
  );
  includes(app, "normalized.status !== \"active\"", "matched game status validation");
  includes(app, "async startMatch(match)", "same-game transition");
  includes(app, "stopQuickMatchSearch?.();", "account-transition cleanup");
  includes(app, "const cancelForAccountTransition = () =>", "centralized cancellation");
  const quickMatchSetupSource = app.slice(app.indexOf("function setupQuickMatch()"));
  assert.equal((quickMatchSetupSource.match(/setupForm\.addEventListener\(\"submit\"/g) || []).length, 1,
    "Quick Match must have exactly one submit listener in the application bundle");
  assert.match(quickMatchSetupSource, /overlay\.dataset\.ready\) return;/, "Quick Match setup listener has a one-time initialization guard");
  assert.match(quickMatchSetupSource, /overlay\.dataset\.ready = "true";/, "Quick Match setup marks its listener initialization");
  includes(quickMatchSetupSource, "event.preventDefault();\n        // closeSetup() hides the form before the first search is dispatched.\n        // A stale/replayed submit event must not reopen the queue or create a\n        // second server ticket during cancellation/reinitialization.\n        if (setup.hidden) return;", "replayed hidden-form submissions cannot create duplicate queue tickets");

  // Legacy compatibility must not swallow real RPC failures.
  includes(app, "if (code !== \"42883\" && !/function .*join_matchmaking_queue|p_region.*does not exist|could not find the function/i.test(message)) throw error;", "narrow legacy fallback");

  console.log("matchmaking-regression: queue, server-authority, preferences, cancellation, and isolation checks passed");
}

run();
