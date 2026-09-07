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
const baseSql = fs.readFileSync(path.join(root, "supabase", "matchmaking.sql"), "utf8");
const intelligentSql = fs.readFileSync(path.join(root, "supabase", "migrations", "20260814_intelligent_quick_match.sql"), "utf8");

function includes(source, fragment, label) {
  assert.ok(source.includes(fragment), `missing matchmaking contract: ${label}`);
}

function run() {
  // Queue identity and server-authoritative pairing.
  includes(baseSql, "user_id uuid not null unique", "one active ticket per account");
  includes(baseSql, "create or replace function public.try_pair_matchmaking_queue", "server pairing function");
  includes(baseSql, "match_source", "matchmaking challenge source");
  includes(intelligentSql, "pg_advisory_xact_lock(hashtextextended('nschess:quick-match'", "serialized pairing");
  includes(intelligentSql, "queue_state = 'matched'", "server match state");

  // Rated/casual, clock, and color preferences are validated server-side.
  includes(baseSql, "game_type in ('casual', 'rated')", "game type constraint");
  includes(baseSql, "preferred_color in ('w', 'b', 'random')", "color constraint");
  includes(baseSql, "clock = 'none' or clock ~", "clock constraint");
  includes(intelligentSql, "p_game_type text default 'casual'", "extended join RPC");
  includes(intelligentSql, "p_preferred_color text default 'random'", "extended color RPC");

  // Client cancellation cannot re-arm a queue after an in-flight join.
  includes(app, "if (signal?.aborted) {\n                cleanup();\n                leaveQueue();\n                return null;\n              }", "post-join abort guard");
  includes(app, "if (!ticketId) throw new Error(\"Matchmaking did not return a queue ticket.\");", "ticket requirement");
  includes(app, "stopQuickMatchSearch?.();", "account-transition cleanup");
  includes(app, "const cancelForAccountTransition = () =>", "centralized cancellation");

  // Legacy compatibility must not swallow real RPC failures.
  includes(app, "if (code !== \"42883\" && !/function .*join_matchmaking_queue|p_region.*does not exist|could not find the function/i.test(message)) throw error;", "narrow legacy fallback");

  console.log("matchmaking-regression: queue, server-authority, preferences, cancellation, and isolation checks passed");
}

run();
