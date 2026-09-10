# Nschess

Static chess learning website ready for GitHub Pages.

## Deploy to GitHub Pages

1. Commit and push this repository to GitHub.
2. Open **Settings -> Pages**.
3. Choose **Deploy from a branch**, select `main`, then `/ (root)`.
4. Save and wait for Pages to publish. The site entry point is `index.html`.

## Local preview

Open `index.html` through a local static server. For example:

```powershell
npx serve .
```

## Static hosting notes

- `data/puzzles.json`, `assets/`, and `favicon.svg` must be committed.
- GitHub Pages supports the website, local progress, puzzles, videos, and piece themes.
- Server-only features under `/api` (shared leaderboards, admin tools, and server-backed auth) require the existing Vercel/Supabase deployment.

## Hosted services

Apply `supabase/auth.sql` and then `supabase/leaderboard.sql` in the Supabase SQL editor before enabling shared accounts and leaderboards. The leaderboard schema permits public reads, while only a signed-in player can create or update the row associated with their own account.

For friend requests, private challenges, and live friend status, apply `supabase/friends.sql` after `supabase/auth.sql`.

The standalone Friends hub is available at `#friends`; the original Play
challenge workspace remains at `#play?mode=friend` for uninterrupted games.

For production social security and realtime friend updates, apply the latest migration
`supabase/migrations/20260812_strengthen_friend_security.sql` after `friends.sql`
and `moderation.sql`. It creates server-owned privacy, block, rate-limit, and
notification records and adds validation around friend requests, challenges,
and challenge chat. Do not bypass these RPCs with direct table writes.

Before enabling live multiplayer, also apply
`supabase/migrations/20260819_release_candidate_security_hardening.sql`. This is
mandatory: it replaces the foundation `save_game_challenge_position` RPC with the
server-authoritative move/FEN validation used by the release candidate. A database
that has only `friends.sql` must not be exposed as a production multiplayer
deployment.

Apply `supabase/migrations/20260812_messaging_privacy.sql` after that migration
to enable persistent direct conversations, message history, unread state,
typing indicators, mute controls, realtime delivery, and server-side
spectating/match-history privacy checks.

Apply the `20260812_store_authority_gifting.sql` migration after the messaging
and privacy migration to enable
server-owned Store catalog, wallets, inventory, transactions, purchase history,
and cosmetic gifting. Seed the catalog through the service-role-only
`admin_upsert_store_catalog(jsonb)` RPC from the deployment's reviewed Store catalog export;
clients cannot define prices, unlock methods, or giftable items. Wallet reward claims are
also server-bounded by source, idempotency, rate limits, and a daily budget; direct profile
wallet updates are not granted to authenticated clients.

The checked-in export is generated from the frontend `storeItems` definitions rather than
a hand-maintained subset. After applying the latest Store catalog migration, run
`node scripts/export-store-catalog.js` and then
`node scripts/sync-production-store-catalog.js --apply` from a secure admin shell with
only the server-only `SUPABASE_SERVICE_ROLE_KEY` environment variable. The sync script
prints before/after ID, price, type, unlock-method, and metadata mismatches and performs
no wallet or inventory writes.

Apply `supabase/migrations/20260812_activity_feed.sql` after the Store migration
to enable the server-owned realtime activity feed. It adds `social_activity`,
activity privacy, idempotent learning-event publishing, and server triggers for
games, rating milestones, and achievements. It also normalizes the final
`user_privacy_settings` shape by adding any missing `allow_spectating` and
`activity_visibility` columns before replacing the composite-returning privacy
RPCs. The client can publish only puzzle/lesson events; visibility, blocks,
expiry, and feed reads are enforced by Supabase RLS/RPCs.

If an existing database already hit a privacy composite mismatch while applying
the Activity Feed migration, run
`supabase/migrations/20260812_social_privacy_schema_repair.sql` first, then
rerun the Activity Feed migration. The repair migration is idempotent and
preserves existing privacy rows.

The social architecture keeps the existing challenge/move RPCs as the protected
realtime chess engine. Friends Hub presence, notifications, messaging, activity,
privacy, Store, and gifts use separate server-authoritative tables and RPCs.
Future social features should add bounded RPCs or event types rather than writing
these tables from the client.

For Quick Match, apply `supabase/migrations/20260730_add_matchmaking_queue.sql`
after `friends.sql`, then apply
`supabase/migrations/20260814_intelligent_quick_match.sql`. The latter upgrades
existing queue rows in place, adds heartbeat/region/state fields, serializes
human pairing, and authoritatively resolves the casual (12s) or rated (25s) AI
fallback. It is safe to rerun on an existing queue without deleting player data.
After the release-candidate security hardening migration, apply
`supabase/migrations/20260908_matchmaking_rating_hardening.sql` so only rated
multiplayer games update Elo; casual games retain their existing progression
rewards without changing ratings.
Then apply `supabase/migrations/20260908_matchmaking_pairing_security.sql` so
the authenticated queue caller owns the server-created matchmaking challenge,
as required by the challenge security trigger.

For private in-app player reports, apply `supabase/moderation.sql` after `supabase/friends.sql`.

## Verification

Run the following before deploying a static change:

```powershell
node scripts/verify-site.js
node scripts/build-pages.js
node scripts/check-deploy-assets.js dist
```

### Authenticated browser verification

The repository includes a Playwright harness for repeatable, real-user checks
without using a personal account. Create dedicated test accounts in the target
Supabase project, copy `.env.e2e.example` to `.env.e2e`, and fill in only those
test credentials. `.env.e2e`, Playwright storage state, screenshots, and test
artifacts are ignored by Git.

### Permanent Stability Gate environment check

Any test that uses Supabase privileged operations, multiple accounts, Realtime,
matchmaking, migrations, or another external service must pass the disposable
non-production environment gate before it is considered testable. The one
documented setup check is:

```powershell
npm run test:environment
```

It detects the complete configuration, rejects production/personal fixture
accounts and file-stored privileged keys, validates disposable account
creation/reset/isolation, probes the required migration surface, and opens the
live Realtime path. A missing prerequisite is reported as
`BLOCKED/ENVIRONMENT`, never silently skipped or downgraded to a mock. See
[the full test-environment contract](docs/TEST-ENVIRONMENT.md).

```powershell
npm install
npm run test:affected
npm run test:full
```

`test:affected` maps changed application files to the relevant static and
browser checks. `test:full` runs `test:environment` first, requires the
complete disposable two-account environment, runs the full regression/build/
deploy suite, authenticates automatically, and verifies
session/logout, Store pending and duplicate-click behavior, wallet/ownership
updates (when `E2E_PURCHASE_ITEM_ID` is configured), shared Name Style identity
surfaces, board/puzzle interaction, and 1366/1024/768/390px layouts. The first
visual review can generate baselines with `E2E_UPDATE_SNAPSHOTS=1`; future runs
compare the navbar screenshots and fail on drift. Never put real-user
credentials or service-role keys in `.env.e2e`. A valid saved browser state is
reused on later runs and is refreshed through the login form only when it has
expired.

The checked-in navbar baselines include the composited 86px translucent header.
The Phase 1 Home surface changed the content sampled through its backdrop blur,
so the responsive navbar captures were regenerated after visual review. This
records the intended compositing change; it does not weaken the pixel assertion
or change navbar behavior.

For a local E2E URL, configure the dedicated non-production public
`E2E_SUPABASE_URL` and `E2E_SUPABASE_ANON_KEY` explicitly in `.env.e2e`; the
environment gate does not infer a potentially production project from
`.env.example` or `supabase/.temp/project-ref`. The local E2E server exposes
the public values only through its development `/api/auth-config` response; if
a value is still missing, it fails with `E2E_SUPABASE_NOT_CONFIGURED` instead
of silently running as Guest Explorer. `test:full` also runs an authoritative
Store preflight:
it reports the 197-item catalog budget and the authenticated account's
authoritative `public.profiles.coins` balance before any optional purchase
test.

If a dedicated account is not already available, use the documented
`npm run test:environment` check against the dedicated staging/test project;
it creates or resets only generated `nschess-e2e-*` fixtures through the
supported Auth Admin API and verifies the authoritative wallet/profile state.
Never provision disposable fixtures in production or through a browser-held
service key, and never use a personal account.

## Chess piece assets

The bundled Lichess piece themes are copied from [lila](https://github.com/lichess-org/lila/tree/master/public/piece) and are licensed under AGPL-3.0-or-later. The license copy is in `assets/pieces/LICENSE.lila`.
## Play Store release prerequisites

The repository now includes a Trusted Web Activity Android project. An upload keystore and the required Play Console configuration are still needed before a Google Play release.

1. Host the production app over HTTPS and use that production domain in the Android wrapper.
2. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SERVICE_ROLE_KEY` in the Vercel environment. Never expose the service-role key in browser code.
3. Apply `supabase/auth.sql`, `supabase/leaderboard.sql`, `supabase/friends.sql`, `supabase/tournaments.sql` when tournaments are enabled, `supabase/moderation.sql` for private player reports, then the social-security, messaging, Store-authority, and `supabase/migrations/20260819_release_candidate_security_hardening.sql` migrations under `supabase/migrations/`. The hardening migration is mandatory before live multiplayer is enabled.
4. Verify the public URLs for `privacy.html`, `terms.html`, and `account-deletion.html` on the production domain. Replace the support email in those pages if your production support address differs.
5. Use the checked-in TWA project in `android/` (`com.nschess.game`) and follow [android/README.md](android/README.md) to create an ignored upload keystore, publish Digital Asset Links, and build the signed `.aab`.
6. Complete Play Console Data Safety, content rating, target audience, ads declaration, app access/reviewer instructions, store listing assets, and testing requirements before production rollout.
7. Test account deletion, report submission, offline fallback, multiplayer reconnect, and mobile layouts against the production deployment.
