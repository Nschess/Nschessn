# Final release hardening

Base: `3303b3494c847b1ed4c55b0827210dac32467bc0`. This is a website-only
checkpoint above all ten accepted premium phases, not authorization to deploy.

## Scope and verification

- Reuse compact inner-page navigation on Home below 560px; mobile controls
  have 44px targets, an unclipped logo and no overlapping actions. Below 360px
  the redundant coin shortcut is omitted; Store remains keyboard-accessible in
  the menu. Tablet controls also meet 44px. Desktop rules are unchanged.
- Bump the service-worker shell to v194 so the corrected CSS replaces v193.
  Cache-generation assertions are updated, not relaxed.
- Extend the built-artifact browser gate to 768px and include Home in mobile
  target/overlap checks. Accessibility coverage uses actual hit testing,
  onboarding dismissal, search focus trapping, Escape, menu-to-Store and
  brand-to-Home keyboard navigation. Focus waits test the required condition
  rather than adding arbitrary sleeps; original assertions remain.
- Four bounded 768x1024 Review fullscreen runs passed the original assertions
  unchanged: each exit target was exactly 44x44 and board size 429px. The
  earlier isolated failure was not reproduced; its cause is not conclusively
  established. No fullscreen product fix or weakened assertion was introduced.

Local evidence uses Node 24.19.0 and existing Playwright, synthetic backend
fixtures and blocked external assets. It is not production/RLS certification.
Home before/after captures cover 320/375/390/768/1366; desktop header geometry
matches the base. Master browser covers 20 routes, Retry and offline recovery.
Store/account race, Friends, Profile, pages, Review, Bots, Learn, Daily,
multiplayer, route, board/cache, E2E safety, syntax and site regressions pass.
The production build is local only. Existing gameplay/backend code is unchanged.

## Staging and recovery evidence (2026-10-12)

The configured approved hostname is `aecmlskxvhosslnbebui.supabase.co`.
It returns ENOTFOUND outside the sandbox while `supabase.com` and `vercel.com`
resolve. Authenticated staging Store/Friends/notifications remain unverified;
no login, fixture reset, purchase or production substitution was attempted.
Project lifecycle/availability must be confirmed by its owner before live tests.

Authenticated, read-only Vercel dashboard inspection verified project
`nschessn`, team `nschess-projects`, current production domain
`nschessn.vercel.app`, source `7ad2f64d9f503642256fdb84c31515e3e8918aa7`, and
Ready retained deployment `3P5mZUjYWoNpUAAH6m4jqpZ7LxHP`:
https://vercel.com/nschess-projects/nschessn/3P5mZUjYWoNpUAAH6m4jqpZ7LxHP

The current deployment's rollback/promote actions are disabled because it is
already current. A retained older production deployment exposes enabled
Instant Rollback and Promote, establishing an available account recovery path.
No action was executed. Retention is enabled: recheck the exact target immediately
before release; today's availability does not guarantee indefinite retention.

## Owner-authorized deployment checklist

1. Approve the exact hardening SHA, confirm a clean checkout and its ancestry
   above the base. Record the Ready rollback deployment above and retain it.
2. Use the established existing-project Vercel release workflow, dedicated
   release branch if required, never main/Pages. Verify project/team/domain and
   exact source SHA before production promotion. No database changes are needed.
3. Smoke-test fresh and existing-browser sessions: Home header at 320/375/390,
   search/menu/profile, Play/bot legal replies, Daily device-local/offline,
   Review fullscreen, Learn, Settings. Verify v194 assets/cache. Use only
   non-destructive account checks; never buy/delete/alter real user data.
4. If a critical regression appears, stop and restore the recorded `7ad2f64`
   deployment through its available Vercel rollback/promote action after checking
   its exact identity. Verify domain and fresh/service-worker-controlled sessions
   again. The restored release's own worker may need a reload to activate; do
   not erase user local progress. No SQL or database rollback is involved.

Remaining limits: unavailable staging, physical-device/screen-reader/cross-browser
coverage and inherited startup cost. A successful restore is not claimed.
No push, deployment, migration, production database access or remote settings
change is part of this checkpoint.
