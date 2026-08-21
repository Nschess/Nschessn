/*
 * Compare and synchronize the authoritative production Store catalog.
 *
 * This script never contains a service-role key. Set the key in the server
 * environment and pass --apply only after reviewing the printed diff:
 *
 *   $env:SUPABASE_URL = 'https://<project>.supabase.co'
 *   $env:SUPABASE_SERVICE_ROLE_KEY = '<server-only key>'
 *   node scripts/sync-production-store-catalog.js --apply
 *
 * An optional SUPABASE_USER_ACCESS_TOKEN enables the read-only get_store_state
 * verification as a real signed-in user. It is never printed or persisted.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const catalogPath = path.join(root, "supabase", "store-catalog.json");

function fail(message) {
  console.error(`Store catalog sync blocked: ${message}`);
  process.exitCode = 1;
}

function env(name) {
  return String(process.env[name] || "").trim();
}

async function request(baseUrl, key, route, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${route}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function readCatalog(baseUrl, key) {
  const rows = await request(baseUrl, key, "store_catalog?select=item_id,item_type,name,cost_coins,rarity,unlock_method,giftable,active,metadata&active=eq.true&order=item_id.asc&limit=5000");
  if (!Array.isArray(rows)) throw new Error("Production store_catalog response was not an array.");
  return rows;
}

function compare(frontend, server) {
  const expected = new Map(frontend.map((row) => [row.item_id, row]));
  const actual = new Map(server.map((row) => [String(row.item_id), row]));
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const extra = [...actual.keys()].filter((id) => !expected.has(id));
  const mismatches = [];
  const stableJson = (value) => {
    const normalize = (entry) => Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]))
      : entry;
    return JSON.stringify(normalize(value && typeof value === "object" ? value : {}));
  };
  for (const [id, row] of expected) {
    const current = actual.get(id);
    if (!current) continue;
    const fields = [
      ["name", String(row.name), String(current.name)],
      ["type", String(row.item_type), String(current.item_type)],
      ["price", String(row.cost_coins), String(current.cost_coins)],
      ["rarity", String(row.rarity), String(current.rarity)],
      ["unlock", String(row.unlock_method), String(current.unlock_method)],
      ["giftable", String(Boolean(row.giftable)), String(Boolean(current.giftable))],
      ["metadata", stableJson(row.metadata), stableJson(current.metadata)]
    ];
    for (const [field, expectedValue, actualValue] of fields) {
      if (expectedValue !== actualValue) mismatches.push({ id, field, expected: expectedValue, actual: actualValue });
    }
  }
  return { missing, extra, mismatches };
}

function printComparison(label, frontend, server) {
  const result = compare(frontend, server);
  console.log(JSON.stringify({
    phase: label,
    frontendItems: frontend.length,
    serverActiveItems: server.length,
    missingIds: result.missing,
    extraServerIds: result.extra,
    mismatches: result.mismatches
  }, null, 2));
  return result;
}

async function verifyStoreState(baseUrl, userToken) {
  if (!userToken) {
    console.log(JSON.stringify({ phase: "get_store_state", attempted: false, reason: "SUPABASE_USER_ACCESS_TOKEN is not set; a service-role token cannot impersonate auth.uid()" }, null, 2));
    return null;
  }
  const response = await fetch(`${baseUrl}/rest/v1/rpc/get_store_state`, {
    method: "POST",
    headers: {
      apikey: env("SUPABASE_PUBLISHABLE_KEY") || userToken,
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: "{}"
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    console.log(JSON.stringify({ phase: "get_store_state", attempted: true, ok: false, status: response.status, error: body }, null, 2));
    return null;
  }
  const catalog = Array.isArray(body?.catalog) ? body.catalog : [];
  console.log(JSON.stringify({ phase: "get_store_state", attempted: true, ok: true, catalogItems: catalog.length, missingIds: compare(JSON.parse(fs.readFileSync(catalogPath, "utf8")), catalog).missing }, null, 2));
  return body;
}

async function main() {
  const frontend = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url) return fail("SUPABASE_URL is not configured.");
  if (!serviceKey) return fail("SUPABASE_SERVICE_ROLE_KEY is not configured. No production write was attempted.");
  if (!/^https:\/\/[^/]+\.supabase\.co$/i.test(url)) return fail("SUPABASE_URL is not a Supabase HTTPS project URL.");
  if (!Array.isArray(frontend) || frontend.length === 0) return fail("Generated catalog is empty.");
  const before = await readCatalog(url, serviceKey);
  const beforeResult = printComparison("before", frontend, before);
  if (!process.argv.includes("--apply")) {
    console.log("Dry run only. Re-run with --apply after reviewing the comparison.");
    return;
  }
  const response = await request(url, serviceKey, "rpc/admin_upsert_store_catalog", {
    method: "POST",
    body: JSON.stringify({ p_rows: frontend })
  });
  console.log(JSON.stringify({ phase: "admin_upsert_store_catalog", rowsReportedByRpc: response }, null, 2));
  const after = await readCatalog(url, serviceKey);
  const afterResult = printComparison("after", frontend, after);
  if (afterResult.missing.length || afterResult.mismatches.length) {
    throw new Error("Production catalog is still incomplete or mismatched after admin_upsert_store_catalog.");
  }
  await verifyStoreState(url, env("SUPABASE_USER_ACCESS_TOKEN"));
  if (beforeResult.missing.length === 0 && beforeResult.mismatches.length === 0) {
    console.log("Production catalog already matched the generated frontend catalog; no catalog rows needed changes.");
  } else {
    console.log(`Production catalog synchronized: ${frontend.length} frontend rows are now active and matched.`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, status: error.status || 0, body: error.body || null }, null, 2));
  process.exitCode = 1;
});
