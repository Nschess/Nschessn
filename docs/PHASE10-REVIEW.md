# Phase 10 — recovery, account isolation and usable mobile controls

Base: `6c07f4fb7d3b4b698dcc410e443ff521ad5765f1` (Phase 9). Phases 1–9
remain ancestors; no cherry-picks from migration-dependent candidates. Local
verification uses Node 24.19.0 and the existing Playwright/Chromium installation.
No database, API, migration, dependency, catalog, homepage markup or artwork changes.

## Confirmed defects and corrections

- Failed route imports remained rejected in the browser's module cache even
  after clicking Retry. An explicit retry now gets a new URL. Successful void
  initializers are no longer mistaken for failure.
- Unavailable auth configuration caused seven startup requests. A shared
  three-second failure cooldown suppresses the burst and permits later retry.
- The service-worker generation had not changed across the premium phases.
  Renewed it, retained lazy optional assets, prevented HTTP errors from replacing
  good cached shells, and extended the event lifetime for cache writes.
- Delayed Store purchases, equip operations, inventory, gifts and errors could
  affect another session. Generation checks now reject stale work, including
  A→B→A; action locks and refresh promises are cleaned by their owners only.
  Partial bundle equip no longer reports unconditional success. These changes
  do not cancel or alter a transaction already accepted by the server.
- Deferred notification routing and saved Review reopening now retain account
  and navigation ownership rather than acting on whichever page is current.
- Study Plan fieldsets widened the entire grid and clipped text on phones while
  the document overflow test still passed. Intrinsic minimums and text tracks
  now shrink correctly. Inner-page phone navigation has non-overlapping 44px
  targets even without the optional icon CDN. Home remains unchanged.
- Review normal sizing used the outer analysis column instead of its capped
  frame, letting the board protrude. Fit now reserves the actual frame/rail.
  Fullscreen Exit had clipped text and could be covered by the next mobile panel.
  It is now a labeled 44px icon control with reserved space outside the squares.
  Screenshot inspection also found a 698px board clipped by the 533px analysis
  row at 768px. Fullscreen now fits that row's measured height; the 429px board
  passes hit-testing at every square, not just a viewport-rectangle check.

## Evidence and repeatability

`scripts/master-runtime-regression.cjs` extracts actual production functions.
It covers delayed success/error, duplicate actions, replacement-lock/promise
ownership, A→B→A, route changes, partial equip, deferred Review, auth failure
recovery and cache poisoning. Mocks are synthetic; no server success is implied.

After `npm run build`, `node scripts/master-browser-regression.cjs` serves the
built artifact on loopback, blocks remote services, and checks 20 routes at
1366/980/390/375/320. It tests actual Retry, guest hydration, real CacheStorage,
upgrade from the old cache, HTTP 503 fallback and offline shell reuse.

Local ignored evidence is under `e2e-artifacts/phase10/`:

- `before-plan/` and `after-targeted/`: mobile clipping/header comparison.
- `final/`: all-route geometry report and 60 screenshots.
- `review/`: actual loaded Review and native fullscreen screenshots.
- `comparison/performance.json`: six alternating cold contexts, three per
  source, identical built assets except the three changed runtime files.
- `gates/`: functional, browser, chess and authority-boundary logs. Earlier
  failing diagnostic logs remain; use the final successful run for each gate.

Unavailable-config startup measurements: requests **7→1** in every sample;
median DOMContentLoaded **1396→1411 ms**. This does **not** establish a load-time
speedup. Both sources have 4907 startup DOM nodes and no eager Daily or Stockfish
request. Decoded resource bytes were 3,725,850→3,734,672 before the final small
fullscreen fit adjustment. Final build: 275 files, **50,941,266 bytes**, versus
50,930,950 bytes at the base: **+10,316 bytes (0.020%)**. The three changed runtime
files add **2,242 gzip bytes** in total. There are no additional runtime assets.

Repeated navigation retained 6295 nodes and the browser's coarse 27.6 MB heap
reading. Three current-route clicks added no history entries or observer/entrance
refreshes. This bounded test is not a general memory-leak proof. Practice piece
selection measured 1.8 ms median; no before/after speedup is claimed for it.

## Coverage and honest limits

Coverage includes Play legal moves/bot reply/undo/restart, board resize/drag and
fullscreen, real local Stockfish and unavailable-engine Review, all 32 Daily
positions and offline persistence, 500 Trainer positions/2032 legal plies,
Rush/Streak/Battle timers/scoring/replay, all 68 local lesson exercises, profile,
Friends, Store/Settings, notification ownership, auth/logout, multiplayer and
matchmaking contracts, dialog keyboard behavior, E2E safety, syntax and build.
Fullscreen testing requires actual unforced Exit clicks, all 64 square centers
to pass hit-testing, board containment inside its analysis row,
restored size and authenticated-mock saved Review reload. Mobile puzzle tests
now require the entire board to fit, not just a square shape.

Authenticated transactions, live friend games, RLS and production deployment
were **not** exercised. Backend compatibility is maintained by leaving API/RPC
contracts unchanged; production availability is not certified by mocks.
Screen-reader use, physical mobile devices, cross-browser behavior and a full
contrast audit remain unverified. The original Home/header design is preserved,
including its pre-existing narrow-screen crowding. Startup remains dominated
by the existing monolithic JS/CSS; this task makes no claim of a smaller bundle.
The approximately 50.94 MB static artifact includes lazy/pre-existing assets;
there are no new runtime assets or dependencies. Evidence/artifacts are not
part of the checkpoint. No push, deployment or production access occurred.

## Checkpoint decision

**READY WITH LIMITATIONS** for owner review, not a production deployment claim.
No unresolved P0/P1 defect was found in the exercised local paths. The final
fullscreen gate passes nine viewports (1920/1440/1366/1024/768/624/390/375/320);
the all-route gate covers 100 route/viewport combinations. API/DB and physical
device verification limitations above remain explicit release considerations.
