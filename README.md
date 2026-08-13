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

For private in-app player reports, apply `supabase/moderation.sql` after `supabase/friends.sql`.

## Verification

Run the following before deploying a static change:

```powershell
node scripts/verify-site.js
node scripts/build-pages.js
node scripts/check-deploy-assets.js dist
```

## Chess piece assets

The bundled Lichess piece themes are copied from [lila](https://github.com/lichess-org/lila/tree/master/public/piece) and are licensed under AGPL-3.0-or-later. The license copy is in `assets/pieces/LICENSE.lila`.
## Play Store release prerequisites

The repository now includes a Trusted Web Activity Android project. An upload keystore and the required Play Console configuration are still needed before a Google Play release.

1. Host the production app over HTTPS and use that production domain in the Android wrapper.
2. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SERVICE_ROLE_KEY` in the Vercel environment. Never expose the service-role key in browser code.
3. Apply `supabase/auth.sql`, `supabase/leaderboard.sql`, `supabase/friends.sql`, `supabase/tournaments.sql` when tournaments are enabled, `supabase/moderation.sql` for private player reports, then the social-security, messaging, and Store-authority migrations under `supabase/migrations/`.
4. Verify the public URLs for `privacy.html`, `terms.html`, and `account-deletion.html` on the production domain. Replace the support email in those pages if your production support address differs.
5. Use the checked-in TWA project in `android/` (`com.nschess.game`) and follow [android/README.md](android/README.md) to create an ignored upload keystore, publish Digital Asset Links, and build the signed `.aab`.
6. Complete Play Console Data Safety, content rating, target audience, ads declaration, app access/reviewer instructions, store listing assets, and testing requirements before production rollout.
7. Test account deletion, report submission, offline fallback, multiplayer reconnect, and mobile layouts against the production deployment.
