# Google Search Console setup

This repository prepares the public pages and sitemap; it does not prove ownership in Search Console or submit anything on the owner's behalf.

1. In Google Search Console, add the URL-prefix property `https://nschessn.vercel.app/` (including HTTPS and the trailing slash).
2. Complete one of Google's offered ownership checks. The HTML-tag method can use Google's exact verification meta tag in the root `index.html` head, which is already included in the build. If using the HTML-file method instead, add the exact downloaded verification file at the site root **and add that exact filename to `staticEntries` in `scripts/build-pages.js`** so it reaches `dist`. Deploy the verification change, verify ownership, and keep it available for future checks. Do not alter Google's supplied contents or commit a placeholder token. A DNS Domain property requires control of the relevant DNS zone; use it only if that control exists.
3. In the verified URL-prefix property, open **Sitemaps** and submit `https://nschessn.vercel.app/sitemap.xml`.
4. Check the sitemap fetch status and page indexing reports. Fix actual 4xx/5xx, canonical mismatch, or exclusion findings; sitemap submission is discovery, not a guarantee of indexing or ranking.

The pages use the production canonical host. This repository cannot verify Search Console ownership, sitemap fetchability at deployment, or Google indexing before publication.
