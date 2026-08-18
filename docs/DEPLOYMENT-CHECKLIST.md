# Staging and production deployment checklist

## Build and assets

- [ ] Run `node --check assets/app.js`.
- [ ] Run `node scripts/verify-site.js`.
- [ ] Run `node scripts/build-pages.js`.
- [ ] Run `node scripts/check-deploy-assets.js dist`.
- [ ] Run `node scripts/multiplayer-regression.js`.
- [ ] Run `git diff --check`.
- [ ] Confirm `review-v133-play-premove` is present in `index.html`, `assets/app.js`, and `service-worker.js`.
- [ ] Publish `dist/` (or the repository root for GitHub Pages) with `offline.html`, `site.webmanifest`, icons, piece assets, and `data/puzzles.json`.

## Supabase migrations

- [ ] Back up the staging database.
- [ ] Apply the legacy foundation scripts required by the project (`auth.sql`, `leaderboard.sql`, and `friends.sql`) in a clean database.
- [ ] Apply `moderation.sql`, `tournaments.sql` when enabled, then the ordered migrations documented in `README.md`.
- [ ] Apply the privacy-schema repair before the Activity Feed migration when upgrading a database with the older privacy composite shape.
- [ ] Apply Quick Match queue migrations in order when Quick Match is enabled.
- [ ] Verify every migration on both a clean database and a copy of the current production schema; record RPC signatures, RLS policies, triggers, and indexes.
- [ ] Confirm service-role-only writes for rewards, ratings, inventory, tournament settlement, and leaderboard updates.

## Authenticated staging tests

- [ ] Login/logout and refresh preserve the session.
- [ ] Two users complete friend request, challenge, white move, black move, rapid moves, refresh, temporary disconnect/reconnect, checkmate, resign, draw, timeout, rematch, and Review Game.
- [ ] Verify no duplicate moves, rollback after server acknowledgement, stale realtime overwrite, clock drift, or duplicate subscriptions.
- [ ] Verify promotion, castling, en passant, spectators, chat privacy, and blocked-user behavior.
- [ ] Verify Quick Match human pairing, cancellation, disconnect cleanup, and AI fallback timeout.
- [ ] Verify Store purchase/equip, gifting, inventory, and server-authoritative coin/reward rejection.

## Accessibility and responsive QA

- [ ] Keyboard-only navigation reaches every active control and board square; focus is visible and Escape closes dialogs/overlays.
- [ ] Screen reader announces board position, move feedback, connectivity state, errors, and empty states.
- [ ] Run Lighthouse Accessibility at 1920×1080, 1366×768, and 375×812; target >95 and investigate every audit failure.
- [ ] Verify reduced-motion, forced-colors/high-contrast, touch targets, and no horizontal overflow.

## Performance and PWA QA

- [ ] Capture Chrome Performance traces for Home, Play, Puzzle, Game Review, Friends, Messaging, Store, Tournament, Academy, and Videos.
- [ ] Record FPS, long tasks, layout shifts, memory/heap growth, paint cost, and Stockfish startup on a low-end device.
- [ ] Install the PWA, verify offline shell and offline announcement, update to the next cache version, and confirm old `nschess-*` caches are removed.
- [ ] Test repeated route navigation for listener/timer/subscription leaks.

## Release decision

- [ ] No console errors/warnings or missing assets in staging.
- [ ] No unresolved security, migration, or multiplayer synchronization blockers.
- [ ] Record rollback owner, Supabase backup, deployment commit, and cache version before production rollout.
