# Nschess release candidate

## Build

- Asset version: `review-v155-legacy-music-retirement`
- Service-worker cache: `nschess-shell-v155-legacy-music-retirement`

## Board interaction polish

- Drag pickup now begins at a five-pixel threshold and snaps the ghost to the legal destination.
- Analysis boards support Ctrl/Meta-click square highlights, Escape cleanup, cyan/violet arrows, and compact precision markers.
- Local Play supports analysis gestures; live Friend and Puzzle boards remain move-only. Perf-lite and reduced-motion paths remain lightweight.
- Premove is opt-in and applies only while waiting for a turn in an active
  live-human Quick Match or Friend Challenge; AI fallback never exposes it.
- Queued premoves now have distinct violet FROM/TO board markers and a
  cancelable status rail below the board controls.
- Premium arrows use board-relative inset geometry, compact asymmetric Precision
  Dart heads, deterministic overlap lanes, and a reusable SVG group with one
  crisp primary stroke plus a quiet static navy depth rail. Unchanged arrow
  state is memoized, marker IDs are stable, and coordinates are rounded to
  prevent idle shimmer. Connected review variations can opt into tiny
  color-matched route waypoints, while ordinary move arrows stay clean. Core
  board and marker sizing now lives in centralized renderer tokens.
- Arrow colors now encode best, primary PV, alternative, support, threat, and
  secondary priorities consistently.
- Release status: **Staging validation required**

## Included

- Keyboard and assistive-technology support already present across the shared board interaction layer.
- Visible focus indicators, reduced-motion and forced-colors handling, touch-sized controls, and vector analysis overlays.
- A global `role="status"` connectivity announcement that reports offline and recovery transitions without changing page layout.
- Stable board interactions: drag cleanup, right/Shift analysis gestures on analysis boards, and no hidden premove rail artifact.
- Local Play annotations now clear only after a committed move; Friend premoves
  revalidate once after an authoritative remote position advance.
- Cache invalidation for the updated HTML, CSS, JavaScript, and route stylesheets.
- Retired Store piano IDs are migrated to a silent valid state, stale audio
  elements are removed, and the service-worker cache is bumped so former
  Store recordings cannot be revived from an old shell.
- Phase 10 stability cleanup clears drag safety timers on every release path and
  aborts active pointer state when the window blurs or the document is hidden.
- Route transitions now cancel active board interactions through one shared
  lifecycle hook without detaching persistent board handlers.

## Deliberately unchanged

Chess rules, Play vs AI, Friend Challenge, realtime game RPCs, Stockfish/Game Review analysis, Store/economy, and Supabase schema are unchanged.

## Known validation limits

The repository checks are static/deterministic. A real production go/no-go still requires two authenticated users against the staging Supabase project, a clean and upgraded migration run, Lighthouse Accessibility measurement, and a browser Performance trace on a low-end device.
