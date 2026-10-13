"use strict";
// Fragments cannot be isolated by HTTP headers. Apply a conservative noindex
// before loading the app, and whenever its existing router changes workspace.
// This is indexing hygiene; API authentication remains the privacy boundary.
(() => {
  const homeTitle = document.title;
  const robots = document.querySelector('meta[name="robots"]');
  const sensitiveParameters = /^(code|access_token|refresh_token|token|error|state|challenge|spectate|tournament)$/i;
  function sync() {
    const hash = location.hash.slice(1);
    const workspace = Boolean(hash && hash !== "top");
    const queryState = [...new URLSearchParams(location.search).keys()].some((key) => sensitiveParameters.test(key));
    const privateState = workspace || queryState || document.documentElement.dataset.authState === "authenticated";
    robots?.setAttribute("content", privateState ? "noindex, follow" : "index, follow");
    document.title = privateState ? "Nschess | Chess workspace" : homeTitle;
    // Never put tokens, player names or saved-game contents into sharing tags.
    document.querySelector('meta[property="og:title"]')?.setAttribute("content", document.title);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute("content", document.title);
  }
  // The app calls pushState for tab clicks without a hashchange event.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      sync();
      return result;
    };
  }
  addEventListener("hashchange", sync);
  addEventListener("popstate", sync);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-auth-state"] });
  sync();
})();
