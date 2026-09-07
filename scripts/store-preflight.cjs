/* E2E Store budget check.
 *
 * This script authenticates only the disposable E2E account with the public
 * Supabase anon key and reads its own public.profiles.coins row. If the
 * authoritative balance is below the catalog budget, it may invoke the
 * server-key-only wallet reset for the two strictly validated generated E2E
 * accounts; it never buys or equips Store items and never falls back locally.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { discoverSupabaseConfig } = require("./e2e-config.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadDotEnv(envFile);

function fail(message, report = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...report }, null, 2));
  process.exitCode = 1;
}

function maskId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function isPlaceholder(value) {
  return /^(?:e2e-primary|e2e-secondary)@example\.com$|replace-with|dedicated-test-password/i.test(String(value || ""));
}

function catalogBudget() {
  const file = path.join(root, "supabase", "store-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(catalog)) throw new Error("supabase/store-catalog.json is not an array.");
  const purchasable = catalog.filter((item) => String(item.unlock_method || item.unlockMethod || "").toLowerCase() === "coins" && Number(item.cost_coins || item.cost || 0) > 0);
  return {
    catalogItems: catalog.length,
    expectedCatalogItems: Number(process.env.E2E_EXPECTED_CATALOG_COUNT || 197),
    purchasableItems: purchasable.length,
    totalCost: purchasable.reduce((sum, item) => sum + Number(item.cost_coins || item.cost || 0), 0)
  };
}

function safeSupabaseConfigReport(config = discoverSupabaseConfig()) {
  return {
    supabaseUrlPresent: Boolean(config.hasUrl),
    supabaseAnonKeyPresent: Boolean(config.hasAnonKey),
    supabaseUrlSource: config.urlSource,
    supabaseAnonKeySource: config.keySource
  };
}

function resetDedicatedE2eWallets() {
  if (process.env.E2E_WALLET_RESET_ATTEMPTED === "1") {
    throw new Error("E2E wallet reset completed but the authoritative balance is still below the catalog budget.");
  }
  const adminKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!adminKey || process.env.E2E_AUTO_RESET_WALLET === "0") return false;
  console.error("E2E wallet is below budget; resetting only the generated primary and secondary E2E accounts through the Auth Admin setup script.");
  process.env.E2E_WALLET_RESET_ATTEMPTED = "1";
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "provision-e2e-account.cjs"), "--wallet-only"], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dedicated E2E wallet reset failed with exit code ${result.status}.`);
  return true;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.code || body?.error_code || "HTTP_ERROR";
    throw error;
  }
  return body;
}

async function resolveSupabaseConfig() {
  const discovered = discoverSupabaseConfig();
  if (discovered.hasUrl && discovered.hasAnonKey) return { url: discovered.url, anonKey: discovered.anonKey, source: `${discovered.urlSource}/${discovered.keySource}` };
  const baseUrl = String(process.env.E2E_BASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl || /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
    const missing = [!discovered.hasUrl ? "public Supabase URL" : "", !discovered.hasAnonKey ? "public Supabase anon/publishable key" : ""].filter(Boolean).join(" and ");
    throw new Error(`Local E2E auth needs ${missing} in project config or .env.e2e. No private key is accepted.`);
  }
  const payload = await jsonRequest(`${baseUrl}/api/auth-config`, { headers: { Accept: "application/json" } });
  if (!payload.url || !payload.anonKey) throw new Error("The deployed /api/auth-config response did not include a Supabase URL and public anon key.");
  return { url: String(payload.url).replace(/\/$/, ""), anonKey: String(payload.anonKey), source: "deployed-api" };
}

async function main() {
  const budget = catalogBudget();
  const configReport = safeSupabaseConfigReport();
  if (budget.catalogItems !== budget.expectedCatalogItems) {
    fail(`Store catalog count is ${budget.catalogItems}; expected ${budget.expectedCatalogItems}.`, { ...budget, ...configReport });
    return;
  }
  const email = String(process.env.E2E_EMAIL || "").trim();
  const password = String(process.env.E2E_PASSWORD || "");
  if (!email || !password) {
    fail(`Missing E2E_EMAIL/E2E_PASSWORD in ${envFile}.`, { ...budget, ...configReport, envFile });
    return;
  }
  if (isPlaceholder(email) || isPlaceholder(password)) {
    fail(`E2E_EMAIL/E2E_PASSWORD in ${envFile} are still placeholders. Use only a disposable dedicated test account.`, { ...budget, ...configReport, envFile });
    return;
  }
  let config;
  try {
    config = await resolveSupabaseConfig();
    const resolvedConfigReport = {
      ...configReport,
      supabaseUrlPresent: true,
      supabaseAnonKeyPresent: true,
      configSource: config.source
    };
    const session = await jsonRequest(`${config.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const userId = String(session.user?.id || "");
    const accessToken = String(session.access_token || "");
    if (!userId || !accessToken) throw new Error("Supabase password authentication returned no user/session.");
    const rows = await jsonRequest(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,public_id,coins&limit=1`, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    });
    const profile = Array.isArray(rows) ? rows[0] : null;
    if (!profile) throw new Error("Authenticated E2E user has no readable public.profiles row.");
    const currentCoins = Math.max(0, Number(profile.coins) || 0);
    const report = {
      ok: true,
      configSource: config.source,
      authUserId: maskId(userId),
      profileId: maskId(profile.id || profile.public_id),
      profileMatchesAuthUser: String(profile.id || "") === userId,
      currentCoins,
      ...budget,
      ...resolvedConfigReport,
      enoughToBuyEveryEligibleItem: currentCoins >= budget.totalCost,
      configuredPurchasePrice: Number(process.env.E2E_PURCHASE_ITEM_PRICE || 0) || null
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.profileMatchesAuthUser) throw new Error("The authenticated user ID does not match public.profiles.id.");
    if (!report.enoughToBuyEveryEligibleItem) {
      if (resetDedicatedE2eWallets()) return main();
      console.error("E2E account is underfunded for a full catalog purchase. No purchase was attempted; provide the server-only key for the isolated E2E wallet reset or run the setup script first.");
      process.exitCode = 2;
    }
  } catch (error) {
    fail(`Authoritative Store preflight failed: ${error.code || "ERROR"} ${error.message || "unknown"}`, { ...budget, ...configReport, envFile });
  }
}

main().catch((error) => fail(`Store preflight crashed: ${error.message || error}`));
