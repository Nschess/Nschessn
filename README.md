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

## Chess piece assets

The bundled Lichess piece themes are copied from [lila](https://github.com/lichess-org/lila/tree/master/public/piece) and are licensed under AGPL-3.0-or-later. The license copy is in `assets/pieces/LICENSE.lila`.
