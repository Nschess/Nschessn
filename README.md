# Checkmate Quest

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

## Verification

Run the following before deploying a static change:

```powershell
node scripts/verify-site.js
node scripts/build-pages.js
node scripts/check-deploy-assets.js dist
```

## Chess piece assets

The bundled Lichess piece themes are copied from [lila](https://github.com/lichess-org/lila/tree/master/public/piece) and are licensed under AGPL-3.0-or-later. The license copy is in `assets/pieces/LICENSE.lila`.
