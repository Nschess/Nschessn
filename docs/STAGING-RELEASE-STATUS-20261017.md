# Staging release preparation — 2026-10-17

This is a local preparation checkpoint, not a passing release candidate.

Base: `651a389ccadf7f30230b11ea0e2423862d2acff9`.
Original release branch remains `codex/phase11-12-staging-release`.
Preparation branch: `codex/phase11-12-staging-release-verified`.

## Changes

- Build the static artifact before checking its deployment assets; inspect `dist`, matching CI.
- Audit the actual human Play entry and tournament lobby rather than their hidden game workspace.
- Check the accessible mobile profile entry when the compact lobby hides username text.
- Run the four navbar pixel checks in dedicated isolated contexts; retain separate route audits.
- Refresh visually reviewed navbar baselines for committed guest-state and compact-header behavior.
- No application/runtime changes.

## Evidence

- Syntax and `git diff --check`: pass.
- Build: 13 public sitemap URLs; deployment assets: 154 references pass.
- Static SEO: 13 metadata/canonical URLs, links, sitemap, robots, structured data and noindex contracts pass.
- Offline E2E safety: 95 checks pass, including production-ref rejection.
- Four isolated navbar snapshots: pass at 1366, 1024, 768 and 390px.
- Daily Practice: production logic, account workspace isolation, actual lesson/Trainer/AI game completion, offline persistence and 320–1366px layouts pass; no page errors.
- Latest full suite: FAIL at `play@768/coachBoard: expected 64 squares, found 0`. The broad suite remains unverified beyond this point. Do not remove this assertion or describe the suite as passing. Investigate deferred board mounting and reproduce before changing runtime code.
- Earlier staging preflight and live matchmaking passed; these are distinct from hosted Preview acceptance.

## External gates

- Approved staging ref `aecmlskxvhosslnbebui` resolves again. Staging schema/Auth/RLS/RPC/Realtime preflight previously passed; no migration was applied.
- All seven required GitHub staging secret names are present. Secret values cannot be read back from GitHub and current remote correctness is not proven by names alone.
- GitHub staging environment restricts deployment to `codex/phase11-12-staging-release` and requires owner review. This new preparation branch is not permitted by that restriction. Do not widen protection implicitly; finalize on the intended release branch only after local checks pass.
- Remote main remains `b82522356466685879bee3da0ac212679c6c0466`; original release branch is unpushed. Latest historical Verify site run `34808928870` failed for missing explicit E2E_SUPABASE_URL. Candidate has the staging environment binding, but has no GitHub CI result.
- Official Vercel CLI still shows SUPABASE_URL and SUPABASE_ANON_KEY shared by Production and Preview. Preview backend isolation is not established.
- Owner must keep existing Production values intact and configure Preview-only SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_PUBLISHABLE_KEY and server-only SUPABASE_SERVICE_ROLE_KEY consistently for staging. Do not paste credentials into chat. The attempted agent credential-transfer method was rejected by automatic approval review because it would emit key values into tool output; it was not executed.
- No branch push, PR, Preview or Production deployment was performed. No hosted acceptance result exists.
- Current Production deployment `dpl_DTLfuCzGt9u1kJsdgcAMyh4x2oFL` and distinct prior deployment `dpl_4Dt6wh3Nag4PTH4uGizDLpnVrKBR` both report Ready. Prior readiness does not prove rollback permission or successful recovery; reverify before publication.

Verdict: BLOCKED. Resolve the local full-suite failure and owner-side Preview credential separation before publishing the feature branch or creating a Preview. Production remains unchanged.
