# Nschess release candidate

## Build

- Asset version: `review-v127-a11y-connectivity`
- Service-worker cache: `nschess-shell-v127-a11y-connectivity`
- Release status: **Staging validation required**

## Included

- Keyboard and assistive-technology support already present across the shared board interaction layer.
- Visible focus indicators, reduced-motion and forced-colors handling, touch-sized controls, and vector analysis overlays.
- A global `role="status"` connectivity announcement that reports offline and recovery transitions without changing page layout.
- Cache invalidation for the updated HTML, CSS, JavaScript, and route stylesheets.

## Deliberately unchanged

Chess rules, Play vs AI, Friend Challenge, realtime game RPCs, Stockfish/Game Review analysis, Store/economy, and Supabase schema are unchanged.

## Known validation limits

The repository checks are static/deterministic. A real production go/no-go still requires two authenticated users against the staging Supabase project, a clean and upgraded migration run, Lighthouse Accessibility measurement, and a browser Performance trace on a low-end device.
