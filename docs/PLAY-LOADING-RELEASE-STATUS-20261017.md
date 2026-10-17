# Play loading fix and staging verification — 2026-10-17

Branch: `codex/play768-staging-fix`, based exactly on `e03d1b1de5495678894073bb0502fc35342ae755`. Final SHA is reported separately, since a commit cannot contain its own SHA. Original checkpoints e03d1b1 and 651a389 and their clean worktrees remain unchanged. The dirty primary checkout, other branches/worktrees and ZIPs are preserved.

This report supersedes the unresolved findings in STAGING-RELEASE-STATUS-20261017.md; that historical file is retained.

## Root cause and application fixes

Holding both `/assets/routes/play.js` and `/assets/play-lobby.css` at 768px deterministically exposed a 720x720 `#coachBoard` with zero squares. The original `play@768/coachBoard` 64-square assertion failed unchanged. The human entry was already visible, so waiting for it did not prove board readiness.

The always-loaded CSS guard depended on `.play-lobby`, a class added by the deferred Play initializer. Before that initializer or its stylesheet arrived, legacy layout rules displayed the empty workspace. The guard now depends only on the absence of active-game/review state, with enough specificity to override the older optional rules. No initializer was moved to startup. The original square-count and geometry assertions remain intact.

Correctly awaited live Friend testing exposed another layout defect: renderPlayLobbyState excluded every Friend/tournament route from is-active-game, including real active games. Both the existing optional lobby CSS and the new shell guard consequently hid their board (64 squares existed, but e2 was not visible/clickable). The flag now recognizes real active special-mode games and completed remote games awaiting result/Review. Pending/accepted lobbies and Review retain their exclusions. Eight execution cases and real live controls verify this; the live board helper now also requires visibility before counting its 64 squares.

The complete account flow exposed two additional persistence defects:

- Provider `clearSession()` recreated account-owned `authPreferences` after centralized workspace clearing. It now removes the record, including on delayed/repeated cleanup.
- Page-exit hooks recreated an empty `visitSnapshot` after logout. They now skip only untouched guest snapshots. Real guest activity and authenticated recaps remain supported.

Execution regressions exercise the shipped cleanup/writer, including repeated sign-out, each real guest activity field and authenticated zero-activity snapshots. Strict browser workspace/session/token assertions remain unchanged.

Cache/asset refresh: `nschess-shell-v201-play-lobby-loading`, `mobile-board-focus-v3`, `daily-practice-v3`. Existing bounded-cache/offline policies remain intact. No dependency, engine preload, startup initializer or new runtime asset was added. Normalized source growth is 89 bytes CSS and 783 bytes JS, including comments; these are not compressed CDN measurements.

## Async readiness defect in the harness

A real friend challenge check exposed a separate harness bug: installed Playwright 1.62.1 returned false from waitForFunction(async () => false) in about 45ms instead of polling to timeout. Its implementation tests the Promise object for truthiness. Prior async status/notification readiness labels therefore did not prove their conditions had become true; no multiplayer application rewrite was justified by that failure.

All eight async readiness call sites now use explicit awaited page.evaluate polling, with bounded deadlines and error propagation. Their underlying predicates and subsequent assertions are unchanged. A real no-network Chromium regression proves false results retry, true resolves, rejection propagates and unresolved predicates time out. It is registered in CI before live environment validation. Final live results must come from a rerun using this correction.

## Test contract corrections

- The Friend live resignation flow now explicitly opens and confirms the existing dialog before waiting for the authoritative completed result. Previously that flow only opened the dialog; no resignation was submitted. Quick Match retains its existing single confirmation sequence. No application confirmation or security control was bypassed.
- Cross-account avatar leakage is checked in actual avatar fields; equipped styles are checked in style attributes. A shared diamond currency glyph no longer falsely identifies Account A. Execution tests still reject genuine stale avatars/styles.
- Store settlement recognizes enabled Unequip for both implemented reversible categories: Name Styles and Last Move highlights. Ownership, equipment, busy/pending/action-lock, authoritative wallet delta and RPC assertions remain required. A new standalone CI regression rejects invalid states and unrelated enabled actions.
- Logout metrics require the actual anonymous renderer: Guest profile, unavailable-statistic dashes, zero Store coins and `0/0 on this device`. Every stale authenticated metric field is individually rejected in an execution regression.
- Compact mobile identity checks require a visible profile link naming the authenticated current account when username text is intentionally hidden. Visible identities retain existing parity/style checks.
- Visual captures wait for auth hydration and set explicit pointer states. Deliberate notification-button hover at 1024px exactly reproduced the intermittent mismatch: 1246 pixels, maximum channel delta 235. The retained 768px baseline contains profile-chip hover, so that capture explicitly uses it; other widths are neutral. Baselines and pixel tolerances are unchanged.
- The Store scroll audit waits for real background hydration to reach network idle before measuring. Its zero-RPC and zero-catalog-mutation assertions are unchanged; no endpoint is filtered or mocked. A deferred social-feed request had previously been misattributed to scrolling.
- Board-sizing tests use existing optional-CDN fixtures to avoid third-party font/icon timing; board bounds and input assertions are unchanged.

## Verification

| Check | Result |
| --- | --- |
| Delayed Play initializer/styles, five widths, real bot controls and active 64-square board | PASS, 10 cases on final application source |
| Active workspace state and correctly awaited async readiness | PASS, eight state cases and real-browser false/true/rejection/timeout cases |
| Production build and deployment assets | PASS, 13 sitemap URLs and 154 local asset references |
| Static SEO, canonicals, links, robots, JSON-LD, noindex/hosting contracts | PASS, all 13 public pages |
| Production/project rejection and fail-closed offline safety | PASS, 95 checks |
| Final application/worker/harness syntax and whitespace | PASS |
| Exact retained navbar snapshots | PASS, four widths with explicit interaction states |
| Focused real staging account/Store/logout flow | PASS in the complete final 77-check rerun after the async polling correction |
| Local equivalent of Live Stability Gate | PASS, 18 checks, no skips or blocks; awaited Quick Match completion, Review and logout isolation |
| Correctly awaited real staging Friend flow | PASS, 25 checks, no skips or blocks; real moves, duplicate rejection, reload, confirmed resignation, terminal idempotency and both Review workspaces |
| Full required staging-backed suite | PASS, 77 passed, 0 skipped, 0 blocked/environment, 0 failed; runner exit 0 |
| Board sizing/input/resize/fullscreen and Play/special-lobby layout | PASS, local coverage spans 320–1920px |
| Board interaction, promotion, route interaction and Daily Puzzle | PASS |
| PWA/offline/cache/failed-install contracts after final persistence fix | PASS |
| Daily Practice real completion, account isolation, offline persistence and responsive layouts after final persistence fix | PASS |
| AI bot regression | PASS unchanged on retry; no page errors |
| Candidate GitHub CI / protected hosted Preview | NOT RUN; publication is not authorized |

AI retry measured about 11509ms input-to-reply and 1913ms engine search after the initial run hit its existing reply deadline. Board sizing initially hit a parallel-batch process timeout, then passed with optional-CDN fixtures. These are local results, not hosted performance improvements or Core Web Vitals measurements.

Ignored evidence includes `final-active-play-lobby-loading-regression.cjs.log`, `final-active-pwa-regression.cjs.log`, `final-active-daily-practice-regression.cjs.log`, `focused-account-final.log`, `focused-friend-complete.log`, `final-local-stability-gate.log`, `full-final-source.log`, `final-visual-explicit.log`, `final-safety.log`, `root-cause-board-sizing-retry.log` and `root-cause-ai-retry.log`. Do not publish raw authenticated artifacts or Playwright storage-state files.

## Staging RPC correction

Official inventory confirms approved `aecmlskxvhosslnbebui` (Nschessn E2E, Sydney) ACTIVE_HEALTHY. Its hostname resolves; staging Auth settings returned HTTP 200. Real preflight verifies disposable accounts, required schema/migration surface, RLS/RPC fixtures and Realtime. Production-ref rejection remains enforced.

The account run exposed PostgreSQL 42702 in deployed `list_gift_inbox`: RETURNS TABLE output names conflict with unqualified status/expires_at/id columns. The deployed definition matched repository source. Additive migration `20261017_gift_inbox_column_qualification.sql` qualifies those references, retaining signature, auth guard and refund behavior. It also removes an unnecessary restored explicit anon execute grant while retaining authenticated execution.

A rollback-only trial passed before the correction was applied solely to the explicitly confirmed active staging ref. Final rolled-back checks prove anon execution denial, authenticated execution, missing-auth rejection and an empty synthetic non-account inbox. Real gift/refund transactions were not exercised. No bulk migration push was used; the direct function query does not reconcile historical migration ledgers. Production has not received this migration or any database change.

## Vercel Preview isolation

Official API project identity: `nschessn`, `prj_WR5AbyJKywncpqJbJc25PUlJMSqo`. Official CLI/API configured four distinct Preview-only sensitive records using credentials obtained for the approved staging ref:

- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_PUBLISHABLE_KEY (compatible staging public/anon key)
- SUPABASE_SERVICE_ROLE_KEY (server-only)

Staging JWT project/role identities were checked before transfer. Values stayed in process memory and child-process stdin: never printed, emitted through tool output, put in visible command arguments, written to transfer files or committed.

The formerly shared URL/anon records were detached from Preview with target-only patches. No Production stored value was supplied/replaced; Production record identities/types were retained and unrelated records' timestamps were unchanged. Independent metadata confirms only these four Supabase names, each with separate Production-only and Preview-only records, no branch overrides/custom-environment attachments. Sensitive values cannot be assumed readable after creation; actual hosted use still needs a newly authorized Preview.

Deployment Protection remains enabled (`all_except_custom_domains`); GitHub repository is Nschess/Nschessn, Production branch main, build `npm run build`, output dist. No AUTH_SITE_URL/AUTH_REDIRECT_ORIGINS override exists. Hosted OAuth acceptance must review exact Preview callback/trusted origins after an authorized URL exists; current server defaults point trusted redirects to Production. Password/Auth connectivity alone does not prove hosted OAuth readiness.

Supported interfaces: https://vercel.com/docs/rest-api/projects/edit-an-environment-variable and https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables .

## GitHub secrets and publication gates

All seven protected staging secret names exist and candidate workflow uses `environment: staging`:

| Secret | Runner variable |
| --- | --- |
| NSCHESS_E2E_SUPABASE_URL | E2E_SUPABASE_URL |
| NSCHESS_E2E_SUPABASE_ANON_KEY | E2E_SUPABASE_ANON_KEY |
| NSCHESS_E2E_EMAIL | E2E_EMAIL |
| NSCHESS_E2E_PASSWORD | E2E_PASSWORD |
| NSCHESS_E2E_SECOND_EMAIL | E2E_SECOND_EMAIL |
| NSCHESS_E2E_SECOND_PASSWORD | E2E_SECOND_PASSWORD |
| NSCHESS_SUPABASE_SECRET_KEY | SUPABASE_SECRET_KEY |

GitHub does not reveal stored secret values; names/mappings and a local pass do not prove remote credentials work. Latest historical Verify site run 34808928870 failed for missing explicit E2E_SUPABASE_URL on main `b82522356466685879bee3da0ac212679c6c0466`. This candidate is unpublished and has no CI result.

Required reviewer remains Nschess (self-review not prevented). Allowed branch is exactly `codex/phase11-12-staging-release`. No policy was widened and no bypass was used. PR jobs use `refs/pull/<number>/merge`, so the current head-branch-only policy will not authorize a PR job. After explicit publication authorization and PR creation, approve only its exact PR merge ref and review the protected job. Do not add a blanket wildcard or remove protection. Official reference: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments .

## Production and remaining owner actions

Official project targets confirm current Production `dpl_DTLfuCzGt9u1kJsdgcAMyh4x2oFL` is READY at `beb833d7a773125edfd9984412bad5f2b7997f7b`. Distinct prior Production `dpl_4Dt6wh3Nag4PTH4uGizDLpnVrKBR` is READY at `a42579601dbe82f8c7c61bf2a546f541d29ff16a`. Both belong to the verified project. This proves retained deployment records, not exercised rollback permission/recovery.

No push, PR, merge, deployment, alias/promotion/rollback, Production account mutation or Production database operation occurred. No credentials need to be pasted into chat.

Remaining actions: explicitly authorize publication of this isolated branch/PR (including any protected Preview automatically triggered by the existing Vercel Git integration; verify that behavior before pushing); approve its exact staging execution-ref policy and protected job; then authorize a protected Preview of the exact verified commit. Verify that new deployment's backend identity, noindex/CDN behavior, all 13 URLs, redirects/hydration, gameplay, Daily Practice, PWA and device layouts. Use approved authenticated owner/team access without a protection bypass. Review exact OAuth callbacks if exercised. Production publication is outside this mission.

Verdict: BLOCKED for release. Candidate CI and hosted Preview acceptance remain unverified; configuration separation alone is not release readiness.
