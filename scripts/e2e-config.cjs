const fs = require("fs");
const approvedProjectRefs = require("./e2e-approved-projects.json");
const productionProjectRef = "jfrvoykwowzthlvzwsmi";

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function blockProject(reason) {
  throw Object.assign(new Error(`BLOCKED/ENVIRONMENT: ${reason}`), {
    status: "BLOCKED/ENVIRONMENT", code: "E2E_PROJECT_NOT_APPROVED", exitCode: 2
  });
}

// Approval is reviewed source, never an environment label or a preflight flag.
// Callers load only their explicit E2E env file before entering this guard.
function assertApprovedE2EProject(values = process.env) {
  const rawUrl = String(values.E2E_SUPABASE_URL || "").trim();
  if (!rawUrl) blockProject("Explicit E2E_SUPABASE_URL is required; application/CLI/remote discovery is forbidden.");
  let parsed;
  try { parsed = new URL(rawUrl); } catch { blockProject("E2E_SUPABASE_URL is not a valid project URL."); }
  const match = parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (!match || parsed.protocol !== "https:" || parsed.username || parsed.password
    || !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(rawUrl)) {
    blockProject("E2E_SUPABASE_URL must be the canonical HTTPS Supabase project origin, without credentials, port, path, query, or fragment.");
  }
  const projectRef = match[1];
  if (projectRef === productionProjectRef) blockProject("The production project is permanently forbidden for live E2E.");
  if (!Array.isArray(approvedProjectRefs) || approvedProjectRefs.some((ref) => !/^[a-z0-9]{20}$/.test(ref))) {
    blockProject("The reviewed E2E project registry is invalid.");
  }
  if (!approvedProjectRefs.includes(projectRef)) blockProject("The project is not in the reviewed E2E registry; no live access or provisioning is allowed.");

  // A remote application could supply a different backend before login.
  // This harness currently supports only its local E2E frontend.
  if (String(values.E2E_BASE_URL || "").trim()) {
    let app;
    try { app = new URL(values.E2E_BASE_URL); } catch { blockProject("E2E_BASE_URL must be a local HTTP(S) origin."); }
    if (!["http:", "https:"].includes(app.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(app.hostname)
      || app.username || app.password || app.pathname !== "/" || app.search || app.hash) {
      blockProject("Live E2E requires a local frontend; remote auth-config discovery is forbidden.");
    }
  }
  return { url: parsed.origin, projectRef };
}

function discoverSupabaseConfig() {
  const { url, projectRef } = assertApprovedE2EProject();
  const anonKey = String(process.env.E2E_SUPABASE_ANON_KEY || "").trim();
  return {
    url,
    projectRef,
    anonKey,
    urlSource: "explicit E2E_SUPABASE_URL (reviewed project)",
    keySource: anonKey ? "explicit E2E_SUPABASE_ANON_KEY" : "missing",
    hasUrl: true,
    hasAnonKey: Boolean(anonKey)
  };
}

// Browser/remote configuration is evidence to check, never approval authority.
function assertApprovedBrowserConfig(config) {
  const expected = discoverSupabaseConfig();
  const actual = assertApprovedE2EProject({ E2E_SUPABASE_URL: config?.url });
  if (actual.url !== expected.url) blockProject("Browser backend does not match the approved E2E target.");
  if (!expected.hasAnonKey || config?.anonKey !== expected.anonKey) {
    blockProject("Browser public configuration does not match the E2E server configuration.");
  }
  return { url: expected.url, anonKey: expected.anonKey };
}

module.exports = { discoverSupabaseConfig, parseEnvFile, assertApprovedE2EProject, assertApprovedBrowserConfig };
