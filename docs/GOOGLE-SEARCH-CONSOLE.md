# Google Search Console setup

Prepared for `https://nschessn.vercel.app/`. This checkpoint does not deploy,
verify ownership, submit a sitemap or request indexing.

## After an approved release

- [ ] Confirm the deployment contains the built `dist/` artifact and the existing
  Vercel `/api` functions. Do not publish the repository root as the static artifact:
  the discovery pages and sitemap are generated during `npm run build`.
- [ ] Fetch `/`, `/learn/`, `/puzzles/`, `/daily-chess-puzzle/`,
  `/play-computer/`, `/game-review/`, `/chess-rules/`, `/chess-openings/`,
  `/chess-notation/` and `/chess-training/` without cookies. Expect HTTP 200,
  useful initial HTML, `index, follow` and each page's absolute production canonical.
- [ ] Confirm `/robots.txt` returns plain text with the production sitemap URL,
  and `/sitemap.xml` returns XML containing exactly the 13 reviewed public URLs.
- [ ] Verify `/index.html` permanently redirects to `/`, and each guide's
  slashless and `/index.html` aliases permanently redirect to its trailing-slash URL.
  Query strings and OAuth returns must still work. Confirm unknown paths return
  HTTP 404 rather than an app page with status 200.
- [ ] Confirm `/api/*`, `/data/*`, `/offline.html`, `/404.html`, and root URLs
  carrying OAuth or invite query parameters have `X-Robots-Tag: noindex, nofollow`.
  Sensitive root query responses also require `Cache-Control: private, no-store`.
  Fragments are handled by the app's early metadata script because HTTP servers
  never receive fragments.
- [ ] Confirm bots, daily puzzles, PWA installability/offline behavior, sign-in,
  and authenticated API access on staging. Keep the existing production backend
  out of automated account mutation tests.

## Property and ownership

- [ ] Add a **URL-prefix property** for `https://nschessn.vercel.app/` in
  [Google Search Console](https://search.google.com/search-console/).
  Choose a domain property only for a domain whose DNS you control.
- [ ] Choose HTML-tag verification and copy the exact `google-site-verification`
  tag Google supplies into the checked-in homepage `<head>`. Rebuild and release
  through the normal approval process, then check the live raw HTML before
  clicking Verify. Keep the tag in future releases. No token is invented or
  included in this SEO checkpoint. Follow Google's
  [ownership verification instructions](https://support.google.com/webmasters/answer/9008080).
- [ ] If choosing HTML-file verification instead, add the exact supplied file to
  the build allowlist so it survives rebuilding, and verify it is publicly served
  at the address Google specifies.

## Discovery and monitoring

- [ ] Submit `sitemap.xml` in the property. It identifies
  `https://nschessn.vercel.app/sitemap.xml`. Google's
  [sitemap guide](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
  explains submission and processing.
- [ ] Use [URL Inspection](https://support.google.com/webmasters/answer/9012289)
  on the home page and a few representative guides. Run a live test, inspect
  fetched/rendered content, confirm Google can access the page and compare the
  declared canonical with Google's selected canonical. Request indexing for
  representative public pages after the release is confirmed.
- [ ] Check Page indexing for blocked pages, unexpected noindex, alternate
  canonicals, soft 404s and server errors. Account fragments, APIs and local
  saved games should never become sitemap entries.
- [ ] Review Performance queries and landing pages once data appears. Useful
  topics include free chess lessons, beginner chess practice, chess puzzles,
  daily chess puzzles and playing chess against a computer. Improve content
  based on real user needs; do not create repetitive keyword pages.
- [ ] Check mobile Core Web Vitals when field data is available. Local Chromium
  results are useful regression evidence, not measurements of real-user LCP,
  INP or CLS on production.
- [ ] If a custom domain replaces the Vercel domain, change the single origin in
  `scripts/seo-pages.cjs`, homepage/legal metadata, robots sitemap declaration
  and any hosting redirects together, then regenerate and rerun the SEO checks.

Discovery and indexing take time and remain search-engine decisions. Sitemap
submission and correct markup do not guarantee indexing or rankings.
