# Changelog

## v144 - Arrow rendering stability

- Simplified arrows to one crisp primary stroke plus a quiet static depth rail.
- Memoized unchanged arrow state and stabilized marker IDs/board coordinates to prevent idle SVG shimmer.
- Refined analysis colors for the warm wood board.

## v143 - Arrow depth polish

- Reduced the navy depth rail and shadow marker footprint so the layered treatment reads as lift, not a duplicate outline.

## v142 - Arrow geometry tokens

- Centralized Precision Dart viewBox, inset, lane, depth, and marker sizing tokens in the existing SVG renderer.
- Kept responsive board-relative sizing and all arrow semantics unchanged.

## v141 - Signal route waypoints

- Added opt-in micro route nodes for connected review variations without adding markers to normal arrows.
- Added a 150ms arrow arrival fade that is disabled in perf-lite, low-performance, reduced-motion, and forced-colors modes.
- Kept route nodes and all arrow layers board-relative, pointer-passive, and compatible with the existing Precision Dart geometry.

## v140 - Arrow color hierarchy

- Added semantic gold, cyan-blue, violet, emerald, red, and neutral arrow roles.
- Priority now controls opacity, glow strength, shaft clarity, head scale, and overlap lane order.

## v139 - Precision Dart glass layers

- Added a restrained color-matched outer glow behind each arrow while keeping the navy depth rail and thin inner accent.
- Simplified performance, reduced-motion, and forced-colors modes by removing the glow layer without removing functional arrows.

## v138 - Precision Dart lanes

- Replaced the previous arrowhead with a smaller asymmetric faceted dart.
- Tuned normal shafts to a 2.5–3px desktop target with a restrained navy depth rail and thin inner accent.
- Added deterministic lateral lanes for three or more intersecting or shared-endpoint arrows.

## v137 - Precision cyan arrows

- Refined SVG arrowheads into compact faceted tips with a seamless shaft connection.
- Normal annotations now use cyan/cool blue; gold remains reserved for best and important moves.
- Reduced outline weight and removed primary glow/animation while retaining layered contrast on every board square.

## v136 - Premium arrow clarity

- Corrected the board-relative SVG stroke units so annotation shafts remain
  immediately readable instead of collapsing to sub-pixel lines.
- Added connected dark depth heads, crisp color-matched primary heads, a
  restrained inner highlight, and a refined gold treatment for best arrows.
- Kept overlay effects pointer-passive and legible in mobile, perf-lite,
  reduced-motion, and forced-colors modes.

## v135 - Premove real-flow feedback

- Fixed the active-board invalidation missing when the Premove setting changes,
  so off-turn pieces immediately become premove-interactable in supported live
  human matches.
- Added distinct violet FROM/TO queue markers and moved the cancelable
  “Premove queued” confirmation out of the board wrapper.

## v134 - Scoped premove preference and premium arrows

- Premove is opt-in (disabled by default) and only available for active human
  Quick Match/Friend Challenge games; AI fallback and spectator/review boards
  never expose a queue.
- Refined board-relative analysis arrows with inset geometry, crisp rounded
  markers, and a lightweight layered depth treatment that remains visible in
  perf-lite and reduced-motion modes.

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
