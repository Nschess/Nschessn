# Nschess search discovery checkpoint

Production base: `beb833d7a773125edfd9984412bad5f2b7997f7b`.
Implementation branch: `codex/nschess-seo`. Audit date: October 13, 2026.
The release remains local; no push, deployment or Search Console submission is
part of this checkpoint.

## Baseline and architectural decision

The production site uses a static HTML shell, a large shared app controller,
lazy route modules and hash navigation. `#tutorial`, `#puzzles`, `#bots` and
`#game-review` are workspaces in the same document, not independent HTTP routes.
Much UI scaffolding is present in initial HTML, but the guided lesson list,
selected puzzle, bot collection and review workspace depend on JavaScript.
Session/account information is hydrated separately by authenticated services or
device storage. It is not generated into public HTML at build time.

Read-only production HTTP checks found:

| URL | Result before this checkpoint |
| --- | --- |
| `/` | HTTP 200; 342,419-byte HTML response; relative `./` canonical |
| `/index.html` | HTTP 200 duplicate homepage |
| `/robots.txt` | HTTP 200; only `User-agent: *` and `Allow: /` |
| `/sitemap.xml` | HTTP 404 |
| `/not-a-real-route` | HTTP 404 |
| `/.well-known/assetlinks.json` | HTTP 404; tracked association file now preserved in build output |

The change adds nine substantive static guides using the existing site colors,
card shapes and typography conventions. These pages include useful chess
instruction, explain feature prerequisites accurately and link into the
existing workspaces. The approved app controller, board CSS, chess engine,
account APIs and database schema are unchanged. The homepage retains its heading
and layout, with an accurate introductory sentence and a guide navigation group.

## Changes and indexing boundaries

- Public pages have unique titles/descriptions, absolute self canonicals, robots
  metadata, Open Graph URLs/titles/descriptions and Twitter summary cards using
  the existing app icon. Legal pages retain their policy text with metadata added.
- A reviewed route inventory generates HTML, related links and the XML sitemap.
  There are no fragment URLs, query URLs, invented lessons, dated puzzle archives
  or private player/game pages in that inventory. No fabricated `lastmod`,
  review stars, claimed Elo ratings or search ranking promises are added.
- Structured data describes only the WebSite, WebPage and visible breadcrumbs.
  No course certification, review, aggregate rating, FAQ or unsupported search
  action is claimed.
- The guides need no JavaScript, remote fonts, tracking code, engine download or
  login to render. Shared discovery CSS is 2,957 bytes and guide HTML is under
  16 KB per page. No dependency was added. Chess assets load when users enter
  the existing app, rather than on the guide pages.
- Vercel explicitly publishes `dist/` static output while retaining root API
  discovery. Redirects consolidate homepage and guide aliases. Unknown routes
  retain real 404 behavior, with a helpful noindex error document.
- `robots.txt` keeps public HTML/CSS/JS crawlable and advertises the sitemap.
  API/data/error responses receive noindex HTTP headers; crawling is not blocked
  because a crawler must be able to read a noindex directive.
- The tiny early metadata script marks every non-home app fragment, sensitive
  OAuth/invite query state and authenticated app view `noindex, follow`, including
  history navigation. It uses generic sharing titles and never inserts identity,
  tokens or game data into the head. Canonicals remain stable and fragment-free.
- Private/personalized app regions carry `data-nosnippet` as additional snippet
  hygiene. Authentication, RLS and account-scoped storage remain the access
  controls; robots metadata is not an authorization mechanism. The public
  guides contain no account data. API/database sources and environment files
  are excluded from the static artifact.
- The service-worker cache generation is bumped and includes the new metadata
  script. Private/query/API cache restrictions, offline app support and PWA
  manifest remain intact. Existing cache-version assertions are updated.
- CI runs static search discovery checks after producing the deployment artifact.

## Public sitemap URLs

Generated at `dist/sitemap.xml`; after release, served at
`https://nschessn.vercel.app/sitemap.xml`.

1. `https://nschessn.vercel.app/`
2. `https://nschessn.vercel.app/learn/`
3. `https://nschessn.vercel.app/puzzles/`
4. `https://nschessn.vercel.app/daily-chess-puzzle/`
5. `https://nschessn.vercel.app/play-computer/`
6. `https://nschessn.vercel.app/game-review/`
7. `https://nschessn.vercel.app/chess-rules/`
8. `https://nschessn.vercel.app/chess-openings/`
9. `https://nschessn.vercel.app/chess-notation/`
10. `https://nschessn.vercel.app/chess-training/`
11. `https://nschessn.vercel.app/privacy.html`
12. `https://nschessn.vercel.app/terms.html`
13. `https://nschessn.vercel.app/account-deletion.html`

## Verification evidence

`npm run test:seo` builds the artifact then runs static checks and real Chromium.
The static checks validate unique metadata, canonical inventory, every shipped
local link/resource, truthful JSON-LD types, robots rules, sitemap inventory,
hosting rules, private-output exclusion and Android association preservation.

Browser checks validate all 13 public pages with JavaScript disabled and no
login, parse XML with a standards DOM parser, exercise guide links and browser
history, load each guide directly, enter each linked chess workspace, test
noindex on private/unknown fragments and OAuth states, simulate authenticated
metadata state, and reload the app and metadata offline. All nine guides are
checked at 320, 390, 768 and 1366 pixels, for 36 responsive layouts without
horizontal overflow and with usable action targets. Mobile and desktop guide
screenshots were visually inspected.

The final mobile lab run for `/learn/` measured LCP **892 ms**, CLS **0**, and
DOMContentLoaded **193 ms** in local headless Chromium at 390 × 844, with 4× CPU
slowdown, 100 ms network latency and 200,000 bytes/second download throughput.
Only discovery CSS was loaded as a page resource (3,257 transfer bytes including
test response overhead). This is a local lab check, not a Lighthouse score or
production field measurement. Raw results/screenshots are in ignored
`e2e-artifacts/seo/`.

Additional relevant checks run for this checkpoint:

- `node scripts/verify-site.js`
- `node scripts/check-deploy-assets.js dist`
- `node scripts/route-interaction-regression.js`
- `node scripts/board-interaction-regression.js` (cache and interaction lifecycle)
- `node scripts/board-sizing-regression.js` (responsive/fullscreen boards and local chess runtime)
- `node scripts/ai-bot-regression.cjs` (38-bot roster, local replies, real Stockfish,
  engine failure, stale-route/restart cancellation and small-screen layouts)
- `node scripts/play-board-priority-regression.js`
- `node scripts/game-review-regression.js`
- `node scripts/auth-logout-regression.js`
- `node scripts/multiplayer-regression.js`
- `node scripts/matchmaking-regression.js`
- `node scripts/e2e-safety-regression.cjs` (95 offline safety checks)
- `node scripts/daily-puzzle-regression.cjs` (32 original positions)
- `node scripts/daily-puzzle-browser-e2e.cjs` (legal moves, local persistence,
  replay, offline reopening and layouts from 320 to 1366 pixels)
- `node scripts/pwa-regression.cjs` (Chromium installability, five layouts,
  offline cache, failed-update preservation and private-cache exclusion)

## Remaining release checks

The unchanged app shell still loads a substantial shared controller and CSS;
this checkpoint makes discovery pages lightweight without refactoring gameplay.
Interactive exercises, today's selected puzzle and engine analysis still require
JavaScript. The daily catalog rotates by UTC date and repeats; it does not
represent a newly authored daily archive. Local lesson/daily records do not
claim account synchronization or account rewards.

Vercel redirect/header behavior, function discovery with the new output setting,
production origin responses, Google-selected canonicals, Google crawling and
field Core Web Vitals must be checked after an approved staged/production release.
The local filesystem server does not pretend to be Vercel's CDN. Physical-device
installation and authenticated/live-backend tests are outside this offline SEO
run; the related source-level security regressions passed and those boundaries
were not edited.

Use [Google Search Console setup](GOOGLE-SEARCH-CONSOLE.md) to verify ownership,
submit the sitemap and inspect representative public pages after deployment.
There is no guarantee of inclusion or rankings.
