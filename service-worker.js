// Bump this name whenever the shipped shell changes. Keep only the critical
// shell in the install cache; route modules and optional styles are cached
// after their first request so install work stays small.
const CACHE_NAME = "nschess-shell-v198-daily-practice";
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./favicon.svg",
  "./assets/app.css?v=mobile-board-focus-v1",
  "./assets/auth-redirect-policy.js?v=review-v203-focus-fit-pieces",
  "./assets/app.js?v=daily-practice-v1",
  "./site.webmanifest",
  "./assets/pwa-install.mjs?v=pwa-v1",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png"
];
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));
const MAX_OPTIONAL_ENTRIES = 160;
let writes = Promise.resolve();
function savePublicAsset(request, response) {
  // Serialize pruning, protect install-shell entries, never cache private URLs.
  writes = writes.catch(() => {}).then(async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
    const optional = (await cache.keys()).filter((entry) => !SHELL_URLS.has(entry.url));
    await Promise.all(optional.slice(0, Math.max(0, optional.length - MAX_OPTIONAL_ENTRIES)).map((entry) => cache.delete(entry)));
  });
  return writes;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("nschess-") && key !== CACHE_NAME)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.headers.has("authorization") || url.pathname.includes("/api/")) return;
  // Only the public app entry and shipped static files are offline eligible.
  // Query-bearing navigation (OAuth codes/tokens) must never enter CacheStorage.
  const safeNavigation = request.mode === "navigate" && !url.search && ["/", "/index.html", "/offline.html"].includes(url.pathname);
  const publicAsset = /^\/(assets|data)\/[\w./-]+\.(?:js|mjs|css|json|png|webp|svg|wasm|woff2?|mp3|wav|ogg)$/i.test(url.pathname)
    || ["/favicon.svg", "/site.webmanifest", "/offline.html"].includes(url.pathname);
  if (!safeNavigation && !publicAsset) return;
  if ([...url.searchParams.keys()].some((key) => key !== "v")) return;

  const isPieceAsset = url.pathname.includes("/assets/pieces/");
  const isStoreAudioAsset = url.pathname.includes("/assets/audio/");
  const isReviewShellAsset = ["/index.html", "/assets/app.css", "/assets/app.js"].some((path) => url.pathname.endsWith(path));
  if (request.mode === "navigate" || isReviewShellAsset || isPieceAsset || isStoreAudioAsset) {
    event.respondWith(fetch(request)
      .then((response) => {
        // Do not replace a working offline shell with a CDN/server error page.
        if (!response.ok) return caches.match(request).then((cached) => cached || response);
        const copy = response.clone();
        event.waitUntil(savePublicAsset(request, copy).catch(() => {}));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || (request.mode === "navigate" ? caches.match("./offline.html") : Response.error()))));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)
    .then((response) => {
      if (!response || response.status !== 200 || response.type !== "basic") return response;
      const copy = response.clone();
      event.waitUntil(savePublicAsset(request, copy).catch(() => {}));
      return response;
    })));
});
