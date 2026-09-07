const offlineSupabaseScript = `
(() => {
  const subscription = { unsubscribe() {} };
  const auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription }, error: null }),
    signInWithOAuth: async () => ({ data: null, error: { code: "E2E_SUPABASE_OFFLINE", message: "Supabase is unavailable in this deterministic test." } }),
    signInWithPassword: async () => ({ data: null, error: { code: "E2E_SUPABASE_OFFLINE", message: "Supabase is unavailable in this deterministic test." } }),
    signOut: async () => ({ data: null, error: null }),
    startAutoRefresh() {},
    stopAutoRefresh() {}
  };
  const unavailable = () => ({ data: null, error: { code: "E2E_SUPABASE_OFFLINE", message: "Supabase is intentionally unavailable in this deterministic test." } });
  window.supabase = {
    createClient: () => ({
      auth,
      rpc: async () => unavailable(),
      from: () => ({ select: async () => ({ data: [], error: null }) })
    })
  };
})();
`;

function installOfflineSupabaseFixture(context) {
  return context.addInitScript({ content: offlineSupabaseScript });
}

async function installOptionalCdnFixtures(context) {
  await context.route("https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await context.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.alloc(0) }));
}

module.exports = { installOfflineSupabaseFixture, installOptionalCdnFixtures };
