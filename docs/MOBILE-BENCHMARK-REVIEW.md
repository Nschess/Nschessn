# Mobile board refinement — 2026-10-13

Base: `003967556ef0625276a849939dfab49e7dea6a32`; retained production baseline:
`a42579601dbe82f8c7c61bf2a546f541d29ff16a`. This is a client presentation,
board-fit, and verification release. No database, API, rewards, engine,
catalog, dependency, or account-contract changes.

## Real comparison and decisions

Public Lichess Home, puzzle, analysis and beginner lesson pages were captured
in Chromium at 320×700, 360×780, 375×812, 390×844, 430×932, 768×1024 and
1366×768, plus 390×650, 844×390 and 768×768. Computer setup was inspected at
the seven main sizes, without submitting a game. Non-GET/HEAD requests were
blocked. These are public reference observations, not authenticated Lichess
gameplay acceptance, copied product assets, or a claim of superiority.

At 390×844 Lichess puzzle/analysis/lesson boards measured 384px, beginning
about 62px below the viewport top. Nschess retains its own branded navigation,
mode selection and teaching context. We reduced redundant containers rather
than copying the reference interface or removing useful status.

| Activity at 390×844 | Base board / top | Candidate board / top |
| --- | --- | --- |
| Daily | 324 / 633px | 348 / 411px |
| Trainer, Rush, Solo Battle | 324 / 520px | 342 / 358px |
| Streak | 324 / 518px | 342 / 356px |
| Learn | 292 / 555px | 340 / 380px |
| Adventure exercise | 300 / 5909px | 332 / 287px |
| Active Play | 343 / 217px | 343 / 217px, intentionally preserved |

Safe content width here means viewport minus 24px, not an assertion that
browser safe-area insets on physical devices were tested. Daily uses 95%,
Trainer 93%, Learn 93%, Adventure 91%, and Play 94% of that width. The Opening
Explorer remains 326px (89%); its controls and board are usable but less
space-efficient than Lichess.

### Corrected causes

- Nested puzzle padding/borders and a conflicting maximum width wasted board
  space. A duplicate banner and pre-board Daily metrics delayed the activity.
  Attribution remains explicit in the solve note; original Daily and Lichess
  CC0 practice catalogs remain separate.
- Learn reserved four coordinate rails on phones. One left/bottom pair,
  smaller frame padding and clearer hierarchy preserve coordinates and enlarge
  the board. The lesson label now states device-local practice, not account XP.
- Adventure placed its existing playable exercise after all story/character
  cards. Moving the same DOM before those cards removes several screens of
  scrolling without changing mission logic. Mobile mission contrast improved.
- Review Settings became an extra grid row under `display: contents`.
  Settings and Exit now share the reserved control rail. Short landscape and
  square tablets put replay beside the board; fitting uses the actual analysis
  track rather than subtracting that separate replay area twice. The 844×390
  board grew from 103px during diagnosis to 297px; 768×768 is 421px.
- A shared child rule overrode dialog Close positioning. A more specific
  component selector and stacking order prevent heading interception; Close
  is 44px and headings reserve its horizontal space.

No Home content/artwork changed (11,640-byte Home markup comparison).
Existing Play clocks, engine controls, chess validation and account boundaries
remain untouched. Short landscape boards fit usable height rather than
enforcing a portrait minimum that clips squares.

## Evidence and reproducibility

Ignored local evidence (not included in deployment or Git):

- `e2e-artifacts/mobile-review-gallery.html`: before/after/reference gallery.
- `e2e-artifacts/mobile-board-comparison.json`: 90 matched board measurements.
- `e2e-artifacts/mobile-reference/`: 40 public-page and seven computer-setup
  screenshots; observed geometry in `report.json`.
- `e2e-artifacts/phase10/before-matched/` and `matched-after/`: matched activity
  screenshots, scrolled square-hit checks and reports. Twenty route screenshots
  were reviewed; focused final reruns cover changed routes and 13 active states
  at ten dimensions rather than claiming every unaffected route was rerun after
  every CSS edit.
- `e2e-artifacts/review-before/`: retained exact-base screenshots from the clean
  `mobile-premium-unified` checkout; `phase10/review/`: final native fullscreen.
- `e2e-artifacts/gate-*.log`, `final-*.log`: execution evidence. Earlier failure
  logs are retained; final logs are distinguished by name, not overwritten as
  though failures never occurred.

The master browser harness checks square geometry, all 64 square centres via
real hit testing after appropriate scrolling, overflow, keyboard lesson
selection, modal close hit targets, route retry, and service-worker recovery.
It uses inert backend fixtures. Accessibility now awaits the lazy bot roster
before measuring it; target-size assertions are unchanged. Review fullscreen
retains the original minimum-board, real DOM/Fullscreen API, 64-square and
exit-restoration assertions. No forced clicks or weakened size checks.

Local release gates: shared board sizing (ten fullscreen layouts and normal
board interactions); Review fullscreen (nine layouts); accessibility (six
widths); Play responsive/fullscreen; all 32 Daily puzzles and browser solve,
hint, reveal, repeat-safe persistence/offline; 500 Trainer positions/2032 legal
plies with Rush/Streak/Battle behavior; 68 Learn exercises; AI roster, legal
replies, failure/cancellation/restart, including real lazy Stockfish loading;
Game Review, multiplayer/matchmaking, profile, remaining-page, route and board
lifecycle regressions; mocked account-switch/Store/notification boundaries;
E2E safety; real Chromium PWA/offline/failed-cache recovery; site/asset checks,
build, JavaScript syntax and whitespace checks.

Live smoke is explicitly guest-only: exact shipped source comparison, touch
play input, route navigation, seven Daily sizes, hint, actual new-cache presence
and offline reopening. It blocks non-read requests and Supabase requests.
It waits for real cache entries after worker control before going offline;
expected offline `/api/auth-config` failure is not confused with missing assets.
Its loopback rehearsal passed before publication. Deployment identity and
live outcome must additionally be checked on the final committed release.

## Performance and limits

Build: 276 files, 50,965,253 bytes versus 50,959,980 bytes at base (+5,273).
Normalized four-shell source growth: 5,191 bytes; gzip growth: 1,030 bytes.
No new runtime image, font, engine or library. The existing approximately
51MB artifact includes optional assets and is not initial download size.

Six alternating cold local samples: base load 3116/3032/2013ms; candidate
2870/2675/1951ms. These noisy desktop observations are not a defensible speedup
claim. Both had 4,926 initial DOM nodes, one auth-config request and no eager
Daily engine/catalog or Stockfish initialization. Existing repeated-navigation
and retained-board-node checks pass; no heap profiler or physical-device
memory claim is made. Actual Daily selection measured 1.8ms in the final
functional run; this is not a controlled before/after optimization claim.

Remaining limitations: physical iOS/Android safe areas/install prompts, manual
screen-reader/contrast audit, and authenticated live social/Store/notification
backend journeys were not re-proven. Native desktop Chromium and mocked
account-boundary checks do not establish those. Nschess still has taller
navigation/context than Lichess; long story/catalog pages remain available
below their primary activity. Reference screenshots stay internal QA only.

## Controlled publication boundary

Push only a new `codex/` release branch, never main/master. The repository's
Pages workflow triggers main/master pushes; this release branch must not
trigger it. Verify Vercel `nschess-projects/nschessn`, Ready status and exact
commit before production promotion. The retained production deployment is
`4Dt6wh3Nag4PTH4uGizDLpnVrKBR` / `nschessn-irne34boa-nschess-projects.vercel.app`,
with source a425796. Inspect recovery availability before promotion. Verify
domain `nschessn.vercel.app`, CSS `mobile-board-focus-v1`, JS
`play-multiplayer-truth-v241`, cache `nschess-shell-v197-mobile-board-focus` and
run the bounded guest smoke afterward. On a critical regression restore that
retained deployment; do not attempt a database change or live account test.
