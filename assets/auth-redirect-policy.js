(function initNschessAuthRedirectPolicy(globalScope) {
  "use strict";

  const OAUTH_RETURN_MARKER = "oauth";

  function normalizeOrigin(value) {
    try {
      const url = new URL(String(value || "").trim());
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "";
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
      return url.origin;
    } catch {
      return "";
    }
  }

  function trustedOrigins(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(normalizeOrigin)
      .filter(Boolean))];
  }

  function createTrustedRedirectUrl({ currentOrigin, allowedOrigins, flow = "session" } = {}) {
    const origin = normalizeOrigin(currentOrigin);
    const allowed = trustedOrigins(allowedOrigins);
    if (!origin || !allowed.includes(origin)) {
      const error = new Error("Social sign-in must start from an approved Nschess address.");
      error.code = "AUTH_REDIRECT_ORIGIN_UNTRUSTED";
      throw error;
    }
    const redirect = new URL("/", origin);
    if (flow === "oauth") redirect.searchParams.set("auth", OAUTH_RETURN_MARKER);
    return redirect.toString();
  }

  const api = Object.freeze({
    OAUTH_RETURN_MARKER,
    normalizeOrigin,
    trustedOrigins,
    createTrustedRedirectUrl
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalScope) globalScope.NschessAuthRedirectPolicy = api;
})(typeof window !== "undefined" ? window : globalThis);
