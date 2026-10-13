# Phase 11 + Phase 12 integrated release candidate

Verdict: **READY WITH LIMITATIONS for controlled preview**, with the offline
verification recorded below. Hosted acceptance checks remain part of the
preview plan. No production publication is authorized by this checkpoint.

## History and preservation

The candidate is one merge commit on `codex/phase11-phase12-integration`.
Its exact SHA is recorded in the delivery message and can be obtained with
`git rev-parse HEAD`; it is intentionally not embedded in its own commit.

First parent: `12b9e9d93d94be5af9e643c0bec9a3234c0a27c0` (Phase 11).
Second parent: `d89051d848a2798185343cf7b4596ac3fa747249` (Phase 12).
Both parents are direct children of production
`beb833d7a773125edfd9984412bad5f2b7997f7b`.

The isolated integration worktree began at the exact Phase 11 checkpoint. A
`git merge --no-ff --no-commit` brought in Phase 12, followed by reviewed
resolutions and one merge checkpoint. Neither original commit was rewritten or
cherry-picked into a replacement history. The primary checkout, original phase
worktrees, existing backup ZIP, `main` and live production were preserved.
No push, deployment, migration, RPC edit or production account mutation occurred.

## Resolutions and integration adjustments

The five Git conflicts were in `service-worker.js` and the cache assertions in
`board-interaction-regression.js`, `daily-puzzle-regression.cjs`,
`mobile-live-smoke.cjs` and `route-interaction-regression.js`. Both phases chose
a different cache generation named v198. The integrated shell uses
`nschess-shell-v199-daily-practice-seo`, retains Phase 11's
`assets/app.js?v=daily-practice-v1`, and caches the SEO metadata script. The
Daily Practice cache assertion is aligned with that same generation.

Routing/navigation, the homepage, package scripts, manifest, gameplay and shared
CSS/JS merged without Git conflicts. They were still inspected for semantic
conflicts. The training guide at `/chess-training/` now describes Daily Practice
and links to `/#plan`, with truthful activity-based completion and local-storage
language. Its URL, title, description and related links are retained. The other
eight original guides render identically to Phase 12. All 13 canonical pages and
sitemap entries remain present.

The private Daily Practice section receives `data-nosnippet`; all app fragments
including `#plan` retain Phase 12's noindex metadata. A Windows checkout exposed
a CRLF-versus-LF failure in the SEO metadata build guard. The guard now normalizes
line endings without weakening its metadata comparison.

Public HTML gets opportunistic offline caching through an explicit allowlist:
only reviewed guide/legal routes, after a visit. These pages are not added to
the install precache. Authenticated requests, query-bearing navigation, API
URLs and arbitrary private paths remain excluded. Previously unvisited public
guides may show the offline fallback until an online visit caches them.

## Both phases retained

Daily Practice's entire app controller, CSS and production account-storage logic
are unchanged from Phase 11. The lesson, Trainer and completed local AI-game
hooks continue to control completion. Opening/skipping a task cannot mark it
complete. Review remains optional and cannot enter the three-step count. UTC-day
history, idempotent completion, storage recovery, local persistence, account
workspace switching and reset boundaries remain in place.

The original PWA manifest, dependency lockfile, API sources and Supabase/RPC
sources are unchanged. The integration adds no dependency, large runtime asset
or new backend contract.

SEO retains crawlable initial HTML, headings/content, unique descriptions/titles,
absolute canonicals, robots rules, social metadata, truthful WebSite/WebPage/
breadcrumb structured data, public internal links and the reviewed sitemap.
Public content is readable without a Nschess login or JavaScript. Interactive
boards and device-local progress still require JavaScript.

The sitemap consists of the production origin `https://nschessn.vercel.app`
with these paths:

| Public feature pages | Policies |
| --- | --- |
| `/` | `/privacy.html` |
| `/learn/` | `/terms.html` |
| `/puzzles/` | `/account-deletion.html` |
| `/daily-chess-puzzle/` | |
| `/play-computer/` | |
| `/game-review/` | |
| `/chess-rules/` | |
| `/chess-openings/` | |
| `/chess-notation/` | |
| `/chess-training/` | |

## Verification and evidence

All test traffic uses isolated loopback servers or synthetic state. The
integration runner strips inherited Supabase/E2E environment variables and
cannot invoke a provisioner, SQL tool, authenticated runner or deployment.
Remote browser services are blocked or replaced with the existing offline
fixtures. Source/account-isolation tests execute the exact app storage
implementation in a synthetic VM; they do not claim live account-provider tests.

The extended Daily Practice browser regression completes an actual lesson board
line and quiz, a legal Trainer line and a played AI game finished through the
resignation controls. It verifies 3/3 persists on an offline reload, reset leaves
underlying lesson completion intact, skips/opens do not complete tasks, and
responsive controls remain usable at 320, 375, 390, 430, 768 and 1366 pixels
(plus the retained 360px case). Guest → A → B → A → guest isolation is verified
using production account-workspace functions, with independent auth lifecycle
and stale-generation source checks.

SEO checks cover all 13 pages without JavaScript/login, the sitemap XML
namespace/inventory, canonical metadata, shipped links and all guide-to-app
destinations. Nine guides at six required widths give 54 responsive checks.
Native navigation, back/forward, direct loading, refresh, hydration, authenticated
metadata state and offline guide → Daily Practice navigation are exercised.

The local HTTP routing rehearsal applies the explicit checked-in Vercel rules:
13 canonical URLs, 19 permanent aliases without loops, query/fragment retention,
private noindex/no-store headers and real 404 behavior. A synthetic client-local
private marker never appears in fetched static HTML or the sitemap. The build
allowlist excludes API/database/environment/test sources; actual API functions
are deployed separately by Vercel from the project root.

The repeatable offline groups are:

```text
npm run build
node scripts/check-deploy-assets.js dist
node scripts/integration-regressions.cjs core
node scripts/integration-regressions.cjs daily
node scripts/integration-regressions.cjs boards
node scripts/integration-regressions.cjs seo
node scripts/integration-regressions.cjs routing
node scripts/integration-regressions.cjs performance
```

Run browser groups sequentially on a quiet host. Logs and JSON reports are saved
under ignored `e2e-artifacts/integration/`; screenshots are also retained under
`e2e-artifacts/seo/` and the Daily Practice group's `screenshots/` directory.
Initial concurrently run browser checks hit a root load timeout and the Daily
Puzzle cold-open limit; isolated reruns passed without relaxing that timing
budget. The public no-JavaScript crawl check waits for DOMContentLoaded so an
optional-resource load event does not determine HTML crawlability.

Core checks cover site structure, route isolation, board input/drag, accessibility,
lessons, game review, auth/logout/OAuth, multiplayer/matchmaking, profile progress,
promotion, original daily puzzle objectives and master runtime contracts.
Browser groups cover lessons, Trainer/Rush/Streak/Battle, Daily Puzzle, PWA,
mobile Play geometry, full-screen/shared board sizing, gameplay and AI bots.
Full-screen board sizing passes at 13 viewports, including 320, 375, 390, 430,
768 and 1366 px; each board fills the measured safe square. Play layout also
passes those six widths. The existing 95 offline E2E safety checks pass.
Syntax was checked for 39 app, route, API, service-worker and verification
files after the final source edits. Production build, artifact asset checks
and static SEO contracts pass on the final candidate tree.

## Build and startup impact

Normalized against Phase 11 to avoid CRLF measurement noise:

| Source | Increase |
| --- | ---: |
| Main app controller | 0 bytes; identical |
| Shared app CSS | 0 bytes; identical |
| Homepage HTML | 3,958 bytes; estimated gzip increase 593 bytes |
| Service worker | approximately 417 additional bytes |
| SEO metadata helper | 1,828 bytes in the Windows artifact; gzip 855 bytes |

Guide HTML stays under 16 KB and uses a shared 2,957-byte stylesheet. Six
alternating local browser samples (three each at baseline and candidate) show
Phase 11 median DOM-ready/load of 2,371/2,385 ms and candidate medians of
2,199/2,230 ms. Candidate startup decoded 1,828 more subresource bytes and
rendered 62 additional nodes; the authentication config request count stayed at
one and neither the Daily Puzzle catalog nor chess engine loaded eagerly. The
SEO mobile guide lab measured LCP 692 ms and CLS 0 with 4× CPU slowdown, 100 ms
latency and 200 KB/s download throughput. The isolated Daily Puzzle cold-open
check measured 373 ms and retained square nodes on input (1.8 ms selection).
These are local lab results, not production Core Web Vitals or physical-device
measurements. Raw baseline/candidate startup samples are recorded separately in
`e2e-artifacts/phase10/phase11-12-integration/performance.json`.

## Limitations and release gates

The unchanged app shell remains large. The integration gives public discovery
pages a lightweight path; it does not refactor the shared gameplay controller.
The existing narrow-screen offline status banner can cover part of a section
heading while visible; routine controls remain usable and the shared CSS is
unchanged from Phase 11. This inherited presentation detail should be reviewed
on physical devices in preview, alongside actual board geometry and installation.

Actual Vercel redirects/headers, function discovery, deployment protection,
preview environment isolation, staging auth-provider behavior and real devices
require a controlled preview. Google's indexing/canonical selection and field
performance require an approved hosted release and observation. No live
authentication-provider or production database test was performed.

Follow [the preview deployment plan](PHASE11-12-PREVIEW-PLAN.md). Production
publication remains a separate owner decision after accepting hosted evidence.
Use [Search Console setup](GOOGLE-SEARCH-CONSOLE.md) only after an approved
production release. Preserve production SHA and original phase checkpoints for
comparison and rollback.
