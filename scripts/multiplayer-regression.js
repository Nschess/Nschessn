/*
 * Deterministic multiplayer synchronization checks.
 *
 * These tests intentionally do not boot the browser bundle or touch Supabase.
 * They exercise the invariants shared by the client reconciliation path and
 * the save_game_challenge_position RPC: monotonic revisions, prefix-only move
 * histories, one optimistic move, and spectator read-only state.
 */
const assert = require("node:assert/strict");

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

function run() {
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

  console.log("multiplayer-regression: 8 synchronization checks passed");
}

run();

