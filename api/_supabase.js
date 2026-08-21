function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const anonKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  const missing = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)");
  if (missing.length) {
    const error = new Error(`Supabase is not configured: missing ${missing.join(" and ")}.`);
    error.code = "SUPABASE_NOT_CONFIGURED";
    throw error;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("URL must use HTTPS");
  } catch {
    const error = new Error("SUPABASE_URL must be a valid HTTPS URL.");
    error.code = "SUPABASE_INVALID_URL";
    throw error;
  }
  return { url, anonKey };
}

function normalizeTrustedAuthOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function getAuthRedirectOrigins() {
  // These are public origins only. Provider client secrets remain exclusively
  // in the Supabase dashboard and must never be exposed by this endpoint.
  const configured = [
    process.env.AUTH_SITE_URL,
    ...String(process.env.AUTH_REDIRECT_ORIGINS || "").split(",")
  ];
  const origins = [...new Set(configured.map(normalizeTrustedAuthOrigin).filter(Boolean))];
  // Keep the established production origin safe by default while allowing a
  // deployment to opt into additional reviewed origins through configuration.
  return origins.length ? origins : ["https://nschessn.vercel.app"];
}

function getSupabaseServiceRoleKey() {
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (serviceRoleKey) return serviceRoleKey;
  const error = new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  error.code = "SUPABASE_SERVICE_ROLE_KEY_MISSING";
  throw error;
}

async function supabaseRequest(path, options = {}) {
  if (!path || typeof path !== "string") {
    const error = new Error("A Supabase REST path is required.");
    error.code = "SUPABASE_INVALID_PATH";
    throw error;
  }
  const { url, anonKey } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || "Supabase request failed.");
    error.code = "SUPABASE_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}

module.exports = { getSupabaseConfig, getAuthRedirectOrigins, getSupabaseServiceRoleKey, supabaseRequest };
