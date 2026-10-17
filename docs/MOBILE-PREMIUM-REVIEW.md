# Mobile workspace checkpoint — 2026-10-12

Base: `a42579601dbe82f8c7c61bf2a546f541d29ff16a`. Isolated worktree:
`C:\Users\palo\.codex\worktrees\mobile-premium-unified\Nschessn`.
This is a presentation/accessibility checkpoint, not a database or reward release.

## Evidence and design decisions

Reviewed the actual Lichess training and Chess.com puzzle entry pages at 390px.
Lichess makes the board and immediate solve actions prominent; Chess.com's larger
onboarding/illustration delays the solve entry. Reused neither artwork nor code.
Nschess retains its own navy/blue/violet identity, existing Home content/artwork,
all published features, and existing chess/engine controllers.

The published baseline and candidate were captured at 320, 360, 375, 390, 430,
768 and 1366px. Twenty routes and eleven active/dialog states were exercised.
Screenshots and JSON are local, ignored evidence, not shipped assets:

- `e2e-artifacts/phase10/before-mobile/`: all twenty baseline routes.
- `e2e-artifacts/phase10/before-activities/`: exact-base active modes/dialogs.
- `e2e-artifacts/phase10/final-mobile/`: twenty-route candidate sweep.
- `e2e-artifacts/phase10/final-focus/`: final Books/Learn/Settings corrections,
  keyboard lesson selection and all active modes/dialogs.
- `e2e-artifacts/phase10/review/`: normal and native fullscreen Review.
- `e2e-artifacts/phase10/mobile-performance/performance.json`: alternating measurements.

## Page-by-page disposition

| Surface | Implemented or deliberately preserved |
| --- | --- |
| Home | Existing content/artwork/structure preserved; mobile spacing and bottom safe-area clearance only. |
| Navigation | Compact shared rhythm, readable bottom labels and practical touch targets; existing route controller preserved. |
| Play / Friendly Challenge | Board geometry and game controls preserved; shared targets and guest entry checked. No new backend guarantees. |
| AI Bots | Compact feature/roster/filter spacing and disclosure targets; engines, difficulty and explicit failure handling preserved. |
| Puzzles / Daily | Five modes in two rows; board nearer entry; solve feedback/actions precede difficulty/statistics. Catalogs, UTC selection, timers, scoring and local-only rewards unchanged. |
| Learn | Fixed clipped horizontal library layout; native collapsible topic/library, current lesson first. All 68 exercises available. Keyboard selection focuses the board; responsive collapse preserves visible focus. |
| Review | Useful empty-route guidance links to practice/Profile; mounted analysis hides it. Replay, engine evidence and fullscreen geometry unchanged. |
| Profile / authentication | Actual Player Pass precedes optional motivational material in mobile DOM/keyboard order. Native optional routine disclosure; removed illustrative +20 XP claim. Desktop grid retained. |
| Settings / PWA | Compact install card, optional offline explanation and tighter settings panels. Install/status module and preference semantics unchanged. |
| Friends / notifications | Compact panels/wrapping navigation and close targets. Existing account ownership/async guards retained. |
| Store | Compact wallet/cards and truthful account-balance copy; server purchases untouched. |
| Leaderboards | Compact cards/tabs; rankings and unavailable-data rules untouched. |
| Study Plan | Compact panels and readable line spacing; recommendations retained, no invented completion. |
| Academy / Paths / Adventures | Shared compact headings/cards; existing learning/practice links and content retained. |
| Rules / Openings / Notation | Shared mobile headings/cards/controls; instruction and interaction unchanged. |
| Books | Three compact metrics and readable navy filters/search labels; existing shelf, provenance and reader unchanged. Light-theme text accounted for. |
| Videos | Two-column learning paths instead of four long stacked entry cards; video content unchanged. |

## Measurements

Matched local Chromium screenshots at 390px, board top measured from viewport:

| Active workspace | Before | After | Board width before → after |
| --- | ---: | ---: | ---: |
| Daily | 841.2px | 633.4px | 308 → 324px |
| Trainer | 682.1px | 519.6px | 316 → 324px |
| Learn | 978.3px | 554.6px | 282 → 292px |
| Play | 217.5px | 217.5px | 343 → 343px |

Three alternating cold contexts per revision, desktop 1366px, external services
blocked with the same isolated fixtures: median load 1812 → 1872ms; median DOM
content loaded 1801 → 1860ms. This does **not** demonstrate a startup speed gain.
One auth-config request in every sample; no eager Daily catalog or Stockfish.
Initial decoded resources 3,738,909 → 3,751,667 bytes (+0.34%); initial DOM nodes
4914 → 4926. These are local uncompressed measurements, not production network/LCP.

Production artifact: 276 files, 50,959,980 bytes versus recorded base build
50,946,360 bytes (+13,620 bytes, 0.027%). The four changed shell sources add
13,371 LF-normalized bytes / 2,626 gzip bytes. No new asset, dependency or engine.
Daily browser check: 194ms local open, 2.1ms square selection, retained square DOM,
successful offline reopening. Trainer selection median 4.5ms. No speedup claim
against an unmeasured baseline. Four Play/Profile cycles retained 300 Profile nodes.

## Verification

PASS:

- Built-artifact guest sweep: 20 routes × 7 widths; no horizontal/panel overflow,
  overlapping header controls, or uncaught page errors.
- Eleven active/dialog states × 7 widths: Daily, Trainer, Rush, Streak, Battle,
  lesson, Friendly Challenge, bot-ready, Play, notifications and search; square boards.
- Final keyboard library open/filter/select/close returns focus to visible board.
- Learn browser: all 68 real board tasks, wrong/illegal moves, hints/keyboard,
  retry/local completion, topic filtering; one delegated list listener.
- Daily: all 32 authored puzzle legality contracts; browser completion/persistence,
  replay without progress mutation and offline reopen; seven widths.
- Puzzle modes: all 500 practice positions/2032 plies valid; correct/wrong moves,
  Rush clock/route pause/timeout/new run, Streak reset and honest solo Battle.
- Profile: seven widths, unavailable guest facts, no duplicate IDs, 44px disclosures.
- Settings: keyboard tab orientation/focus/Home/End, persistence and independent reset;
  Store/Friends/Profile/leaderboard responsive guest checks.
- AI Bots: legal local reply, real lazy Stockfish reply, explicit engine failure,
  restart/navigation stale cancellation and bounded worker contract.
- Accessibility: six desktop/mobile viewports, visible touch controls, dialogs,
  keyboard trapping/restoration and responsive navigation.
- Review native fullscreen: final seven-width run passes all geometry, playable-square,
  controls/replay/evaluation visibility and strict 44px exit checks. One initial
  768px target assertion was intermittent; isolated 768px and full final rerun pass.
  Diagnostic geometry was added, not an assertion relaxation. Engine-unavailable
  analysis remains honestly unavailable in this synthetic Review fixture.
- Play board-priority/special-lobby isolation: seven existing viewport contracts.
- Production-source inert regressions: Game Review, Friends, Profile, remaining pages,
  Store/account A→B→A/notifications/Review stale ownership, board lifecycle, routes,
  multiplayer, matchmaking, Learn, Books and site structure.
- E2E safety: 95 offline rejection/cleanup contracts; no live provisioning or SQL.
- PWA: Chromium installability/icons/gesture, five widths, Back, offline shell,
  HTTP 503 cache preservation, private API exclusion and bounded cache contracts.
- Build, JavaScript syntax and Git whitespace checks.

Early failures were investigated: obsolete cache-path test pins were updated to
the shipped version; stricter Profile checks exposed overriding 42px selectors
and now pass; Books contrast was corrected after screenshot review; lesson focus
handoff was tested against actual DOM. One puzzle timing check failed under
concurrent browser load and passed on the focused rerun without assertion changes.

## Boundaries and limitations

No API, RPC, SQL, migration, canonical rating/progression/settlement or catalog
changes. Service worker changes only version the updated shell. Runtime evidence
and screenshots remain ignored. Primary checkout, ZIP and other worktrees untouched.
No push, deployment, production database access or real account mutation.

Authenticated social/Store transactions here are production-source mocked/inert
checks, not new live backend acceptance. Real iOS/Safari install, physical-device
touch, assistive-technology and production-network measurements remain unverified.
The inherited large shell and long startup tasks remain a future measured
performance opportunity, not something this presentation checkpoint claims fixed.

Verdict: **READY WITH LIMITATIONS for owner release review**, not already deployed.
