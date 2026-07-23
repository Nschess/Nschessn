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

This repository is a web/PWA application. A signed Android App Bundle and Play Console configuration are still required before a Google Play release.

1. Host the production app over HTTPS and use that production domain in the Android wrapper.
2. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SERVICE_ROLE_KEY` in the Vercel environment. Never expose the service-role key in browser code.
3. Apply `supabase/auth.sql`, `supabase/leaderboard.sql`, `supabase/friends.sql`, `supabase/tournaments.sql` when tournaments are enabled, and `supabase/moderation.sql` for private player reports.
4. Verify the public URLs for `privacy.html`, `terms.html`, and `account-deletion.html` on the production domain. Replace the support email in those pages if your production support address differs.
5. Create the Android project using your own package ID and signing key, then build and upload a signed `.aab`. Package identity and signing credentials are intentionally not stored in this repository.
6. Complete Play Console Data Safety, content rating, target audience, ads declaration, app access/reviewer instructions, store listing assets, and testing requirements before production rollout.
7. Test account deletion, report submission, offline fallback, multiplayer reconnect, and mobile layouts against the production deployment.
