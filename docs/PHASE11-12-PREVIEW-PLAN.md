# Controlled preview plan for the Phase 11 + Phase 12 candidate

This is a plan only. No preview or production deployment, push, database
migration, RPC change or production account mutation was performed during
integration. Use the exact integrated checkpoint recorded in
[the integration report](PHASE11-12-INTEGRATION.md).

## Before deploying a preview

1. Obtain the owner's authorization for the preview project and deployment.
   Keep the production project, `main`, original phase branches/worktrees and
   backup ZIP unchanged. Do not promote a preview, assign the production domain
   or run a command with `--prod` as part of preview validation.
2. Prefer a separate preview project with a reviewed non-production backend.
   Otherwise confirm the existing project's **Preview** environment does not
   inherit production Supabase configuration. Do not link this worktree to the
   production project by accepting an unreviewed CLI default.
3. Set backend environment variables only to the owner's approved staging
   project. Never reuse the production service-role key. Configure
   `AUTH_SITE_URL` and `AUTH_REDIRECT_ORIGINS` for the exact HTTPS preview origin,
   and add that origin to the staging provider's redirect allowlist if sign-in
   is to be tested. A public auth-config response must describe staging only.
   Do not expose server-only keys in HTML, bundles, logs or screenshots.
4. Keep deployment protection enabled. Verify an effective
   `X-Robots-Tag: noindex` on preview responses, including any preview aliases or
   custom preview domain. Production canonical URLs intentionally remain in the
   candidate; they are not a substitute for preview protection/noindex. Do not
   submit the preview sitemap to search engines.
5. Use the repository's `vercel.json`: `buildCommand: npm run build`,
   `outputDirectory: dist`. Deploy the whole project root so Vercel can also
   discover the existing `api/` functions. Uploading only `dist/` produces a
   static-only site and cannot validate account APIs. There is no global SPA
   catch-all rewrite and no global trailing-slash rule affecting API routes.
6. Preserve existing backend/RPC contracts. Neither phase adds a database
   migration. If the preview backend is incompatible, stop and report the
   mismatch instead of changing production or applying unreviewed SQL.
7. Verify the preview uses a supported Node runtime and the unchanged lockfile.
   Local verification used Node 24 and the existing Playwright dependency;
   existing CI remains configured for Node 20. Record the preview build/runtime
   version and function discovery in the deployment evidence.

Vercel documents [environment separation](https://vercel.com/docs/deployments/environments),
[deployment protection](https://vercel.com/docs/deployment-protection), and
[project configuration](https://vercel.com/docs/project-configuration/vercel-json).
The separate-project choice is the integration recommendation for reducing the
risk of inherited production environment values.

## Read-only HTTP checks on the preview

- Inspect all 13 canonical public URLs using a protection bypass scoped to the
  owner's test session. Expect useful HTML, the production canonical URL,
  distinct titles/descriptions and preview noindex. Also test with JavaScript
  disabled. Public content must not depend on a Nschess account.
- Fetch `/robots.txt` and `/sitemap.xml`; verify the 13 production URLs, XML
  namespace and absence of private routes, fragments or queries. Confirm the
  homepage and all nine original guides are reachable through real links.
- Check `/index.html` and the 18 guide aliases for permanent redirects, correct
  trailing-slash destinations and no redirect loops. Exercise OAuth query and
  browser-fragment preservation through the homepage alias. Check an unknown
  path returns actual HTTP 404 rather than the home page with HTTP 200.
- Verify API/data/error noindex headers and private/no-store headers on
  sensitive root query states. Rehearsal tests cover the intended repository
  rules; only a deployed preview can confirm Vercel's actual CDN behavior.
- Confirm `/api/auth-config` uses staging, and unauthenticated requests to
  protected APIs expose no private data. Use health and configuration endpoints
  without executing admin actions, account modifications or provisioning.
- Verify `/.well-known/assetlinks.json`, manifest, icons, stockfish assets,
  licenses and route modules survive the build. Do not change the Android
  signing association as part of this release.

## Browser acceptance on the preview

- At **320, 375, 390, 430, 768 and 1366 px**, inspect Daily Practice, public
  guides, Play boards, Trainer and Daily Puzzle. Check readable text, visible
  controls, board size, touch targets and horizontal overflow.
- Open `/chess-training/`, enter Daily Practice, navigate to lessons, Trainer
  and bots, then test back/forward and refresh. Opening/skipping tasks must not
  fabricate completion. Complete a real lesson, Trainer line and local AI game;
  verify the three-step count and reset behavior. Review stays optional.
- Install/use the PWA where supported. After online visits, go offline and
  refresh the app and a previously visited public guide. Follow the guide back
  into cached Daily Practice. Check persistence and that OAuth/query/API/private
  URLs never enter the worker's public cache. A never-visited guide may show the
  noindex offline fallback rather than its full content.
- Use only owner-approved disposable **staging** accounts for any live sign-in,
  account-switch or server-backed verification. Keep production accounts out of
  the test. This checkpoint's account-isolation evidence exercises the exact
  production storage implementation with synthetic accounts; it does not claim
  a live authentication-provider test.
- Check startup resources: the shared app should not eagerly load Stockfish or
  the daily puzzle catalog. Public guides should load only their lightweight
  stylesheet. Record timing distributions rather than treating one local lab
  sample as production Core Web Vitals.

## Owner publication gate

Record the preview URL, exact commit, build log, HTTP redirect/header evidence,
backend identity, viewport screenshots and accepted limitations. Production
publication requires separate owner authorization after preview acceptance.
Keep the current production checkpoint available for rollback. Search Console
ownership verification and sitemap submission follow an approved production
release, using [the existing checklist](GOOGLE-SEARCH-CONSOLE.md).
