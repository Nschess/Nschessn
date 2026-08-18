# Changelog

## v133 - Play arrow lifecycle and premove reconciliation

- Clear local Play analysis arrows and gesture highlights only after a real
  chess move commits; illegal drops, rerenders, and aborted drags preserve them.
- Revalidate one queued Friend premove after an authoritative remote position
  advance, preventing early execution and duplicate moves while cancelling
  invalid premoves cleanly.

## v132 - Play board arrows and overlay isolation

- Enabled right-button analysis arrows on the local Play board while keeping active Friend games move-only.
- Preserved Play user annotations across board rerenders and kept analysis SVG layers board-relative, transparent, and pointer-passive.

## v131 - Board lifecycle cleanup

- Added a shared route-transition cancellation hook that clears active board
  pointers, ghosts, captures, timers, and drag classes without rebuilding
  persistent board registrations.
- Rotated the shell and lazy-route asset versions to invalidate v130 safely.

## v130 - Board interaction validation and cleanup

- Clear drag safety timers on normal release, Escape, blur, visibility change,
  and route detach so no orphaned timer survives an interaction.
- Abort active pointer state on window blur or hidden-tab transitions, removing
  ghosts, captures, drag classes, and analysis gestures safely.
- Restore the Adventure board's square identity metadata so its shared board
  interaction engine can resolve source and destination squares.
- Rotated the asset and service-worker cache version to invalidate v129 safely.

## 2026-08-17 — RC accessibility and release hardening

Release asset set: `review-v127-a11y-connectivity`

- Added a global, accessible offline/reconnected announcement for cloud-dependent features.
- Preserved the existing board keyboard semantics, focus indicators, reduced-motion rules, and forced-colors support.
- Rotated the application/service-worker cache version so the accessibility/runtime update invalidates stale assets.
- Added the release-candidate staging checklist and deployment notes under `docs/`.

No chess rules, multiplayer RPC contracts, Store behavior, or Supabase schema were changed in this release candidate.

## 2026-08-18 — Board interaction stabilization

Release asset set: `review-v128-board-stability`

- Fixed the hidden premove rail so it cannot render as a dark strip over the board.
- Made drag ghost cleanup exception-safe and available in perf-lite mode without heavy effects.
- Enabled the existing analysis gesture contract for Review, Tutorial, and Opening Explorer: right-drag arrows, Shift-drag arrows, preview cleanup, and right-click clearing.
- Kept live Friend Challenge and Puzzle boards in move-only mode; analysis overlays remain disabled there.

## v129 - Board interaction polish

- Reduced drag pickup threshold and snap legal drops to the destination square.
- Added high-priority, lightweight drag ghost styling with a dimmed source piece.
- Added Ctrl/Meta-click analysis highlights and Escape cleanup for analysis boards.
- Added cyan/violet primary arrows, rounded arrowheads, violet premove targets, and reduced-motion/perf-lite handling.
