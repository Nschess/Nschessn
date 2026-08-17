# Changelog

## 2026-08-17 — RC accessibility and release hardening

Release asset set: `review-v127-a11y-connectivity`

- Added a global, accessible offline/reconnected announcement for cloud-dependent features.
- Preserved the existing board keyboard semantics, focus indicators, reduced-motion rules, and forced-colors support.
- Rotated the application/service-worker cache version so the accessibility/runtime update invalidates stale assets.
- Added the release-candidate staging checklist and deployment notes under `docs/`.

No chess rules, multiplayer RPC contracts, Store behavior, or Supabase schema were changed in this release candidate.
