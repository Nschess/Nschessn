# Nschess release candidate

## Build

- Asset version: `review-v131-board-lifecycle`
- Service-worker cache: `nschess-shell-v131-board-lifecycle`

## Board interaction polish

- Drag pickup now begins at a five-pixel threshold and snaps the ghost to the legal destination.
- Analysis boards support Ctrl/Meta-click square highlights, Escape cleanup, cyan/violet arrows, and rounded markers.
- Live Play/Friend/Puzzle boards remain move-only; perf-lite and reduced-motion paths remain lightweight.
- Release status: **Staging validation required**

## Included

- Keyboard and assistive-technology support already present across the shared board interaction layer.
- Visible focus indicators, reduced-motion and forced-colors handling, touch-sized controls, and vector analysis overlays.
- A global `role="status"` connectivity announcement that reports offline and recovery transitions without changing page layout.
- Stable board interactions: drag cleanup, right/Shift analysis gestures on analysis boards, and no hidden premove rail artifact.
- Cache invalidation for the updated HTML, CSS, JavaScript, and route stylesheets.
- Phase 10 stability cleanup clears drag safety timers on every release path and
  aborts active pointer state when the window blurs or the document is hidden.
- Route transitions now cancel active board interactions through one shared
  lifecycle hook without detaching persistent board handlers.

## Deliberately unchanged

Chess rules, Play vs AI, Friend Challenge, realtime game RPCs, Stockfish/Game Review analysis, Store/economy, and Supabase schema are unchanged.

## Known validation limits

The repository checks are static/deterministic. A real production go/no-go still requires two authenticated users against the staging Supabase project, a clean and upgraded migration run, Lighthouse Accessibility measurement, and a browser Performance trace on a low-end device.
