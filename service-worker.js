// Bump this name whenever the shipped shell changes. Keep only the critical
// shell in the install cache; route modules and optional styles are cached
// after their first request so install work stays small.
const CACHE_NAME = "nschess-shell-v175-social-oauth";
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./favicon.svg",
  "./assets/app.css?v=review-v175-social-oauth",
  "./assets/auth-redirect-policy.js?v=review-v175-social-oauth",
  "./assets/app.js?v=review-v175-social-oauth",
  "./site.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png"
];

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
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  const isPieceAsset = url.pathname.includes("/assets/pieces/");
  const isStoreAudioAsset = url.pathname.includes("/assets/audio/");
  const isReviewShellAsset = ["/index.html", "/assets/app.css", "/assets/app.js"].some((path) => url.pathname.endsWith(path));
  if (request.mode === "navigate" || isReviewShellAsset || isPieceAsset || isStoreAudioAsset) {
    event.respondWith(fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || (request.mode === "navigate" ? caches.match("./offline.html") : Response.error()))));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)
    .then((response) => {
      if (!response || response.status !== 200 || response.type !== "basic") return response;
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    })));
});
