# Browser-installed Nschess

This release extends approved checkpoint 660a068 without backend changes. Home
content/artwork, authentication and account authority remain unchanged.

## Installation

- Android Chrome: Settings → Install Nschess when the browser offers installation,
  or browser menu → Install app / Add to Home screen.
- Windows Chrome/Edge: address-bar install icon or browser menu → Install Nschess.
- iPhone/iPad Safari: Share → Add to Home Screen; enable Open as Web App if offered.
- Other browsers: use the platform's supported installation/shortcut mechanism,
  or continue using the website. A shortcut is not proof of standalone installation.

The Settings action never opens a prompt without a click, never repeatedly nags,
and does not equate prompt acceptance with completed installation. `appinstalled`
is the browser confirmation; standalone detection only describes the current window.

## Icons and offline boundaries

Existing 192/512 PNG icons and SVG favicon are retained from repository commit
a274d16, "Android release ready". They use the project's geometric N monogram,
not a third-party chess illustration. No new artwork or third-party icon was added.
The 512 icon supplies maskable support; decorative outer edges may be cropped.
The 192 icon is also the Apple touch icon.

Cache v195 installs only the existing small shell plus the 2.5 KB installation
module, not engines, books, music, or puzzle catalogs. Optional shipped public
assets cache only after use, with at most 160 optional entries. Core shell entries
are protected from pruning. APIs, cross-origin requests, Authorization-bearing
requests, unknown URLs and token/code-bearing navigation are network-only.
No account data or transactions are placed in CacheStorage by this worker.
Local practice data remains device-local and is not protected by app installation.

Previously loaded local practice/lessons/Daily assets can reopen offline. Optional
engines/content must first finish loading online; evicted assets need internet.
Authentication, friends, multiplayer, cloud history and purchases require internet.
Cache eviction by the browser/OS is possible. Failed installation retains the prior
cache; HTTP errors do not replace working cached shell assets.

## Verification and limits

`npm run build` then `npm run test:pwa` uses real Chromium's manifest and
installability inspection, PNG dimensions, offline shell/503 recovery and layouts
320/375/390/768/1366. It exercises native-offer/user-gesture semantics with a
synthetic browser event, separately from actual Chromium installability. Worker
contract tests run the production worker source for private request exclusion,
bounded optional cache and failed-install preservation.

Physical Android/iOS/Windows installation and OS launch screens are not automated
proofs. Authenticated Store/Friends/notifications staging E2E remains unavailable
because the approved staging hostname fails DNS; guest production smoke is not
a substitute. Retained rollback target is production deployment
3P5mZUjYWoNpUAAH6m4jqpZ7LxHP, source 7ad2f64d9f503642256fdb84c31515e3e8918aa7.
