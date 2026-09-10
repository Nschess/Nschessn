/*
 * Provision the permanent disposable Account B for authenticated E2E tests.
 *
 * This uses Supabase's supported Auth Admin REST API. It never writes
 * auth.users/auth.identities directly and never persists or prints a service
 * role key or password. The preferred Supabase secret key (or legacy
 * service-role key) must exist only in the invoking process environment.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseEnvFile } = require("./e2e-config.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");
const E2E_WALLET_BALANCE = 1_000_000_000;
// The intelligent Quick Match RPC starts with a narrow candidate band. Keep
// the two disposable live accounts on deterministic, distinct ratings whose
// difference is inside that initial band so the E2E exercises real pairing
// rather than an accidental incompatible fixture contract.
const E2E_PRIMARY_MATCHMAKING_RATING = 1450;
const E2E_SECONDARY_MATCHMAKING_RATING = 1520;
const walletOnly = process.argv.includes("--wallet-only");
const fixtureOnly = process.argv.includes("--fixture-only");
const environmentCheck = process.argv.includes("--environment-check");
const safeTargetEnvironments = new Set(["local", "development", "test", "staging"]);

function fail(message) {
  throw new Error(`E2E Account B provisioning blocked: ${message}`);
}

function envValue(name, values = {}) {
  return String(process.env[name] || values[name] || "").trim();
}

function readE2eValues() {
  return fs.existsSync(envFile) ? parseEnvFile(envFile) : {};
}

function writeEnvValue(file, key, value) {
  // CI receives both disposable accounts through secret-backed environment
  // variables. Never materialize those credentials in a workspace file.
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" || process.env.E2E_NO_ENV_FILE_WRITE === "1") return;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}=.*$`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.replace(/\s*$/, "\n")}${line}\n`;
  fs.writeFileSync(file, next, { encoding: "utf8", mode: 0o600 });
}

function mask(value) {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : "[set]";
}

function safeEmailLocal(email) {
  return String(email || "").split("@", 1)[0].replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
}

function isGeneratedE2eEmail(email) {
  return /^nschess-e2e-b-[a-f0-9]{8,32}@proton\.me$/i.test(String(email || ""));
}

function isGeneratedPrimaryE2eEmail(email) {
  return /^nschess-e2e-[a-f0-9]{8}@proton\.me$/i.test(String(email || ""));
}

function resolveAdminCredential() {
  const secretKey = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (secretKey) return { key: secretKey, source: "secret", modern: true };
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (serviceRoleKey) return { key: serviceRoleKey, source: "legacy-service-role", modern: false };
  return null;
}

function isModernSecretKey(key) {
  return /^sb_secret_/i.test(String(key || ""));
}

async function requestJson(url, key, options = {}) {
  const { serverCredential = false, ...fetchOptions } = options;
  const modernSecret = Boolean(serverCredential && isModernSecretKey(key));
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      apikey: key,
      ...(modernSecret ? {} : { Authorization: `Bearer ${key}` }),
      Accept: "application/json",
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(fetchOptions.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = response.status;
    error.code = body?.code || body?.error_code || "";
    throw error;
  }
  return body;
}

async function listAdminUsers(baseUrl, serviceKey) {
  const users = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await requestJson(`${baseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`, serviceKey, { serverCredential: true });
    const batch = Array.isArray(result?.users) ? result.users : Array.isArray(result) ? result : [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users;
}

async function readAdminUser(baseUrl, serviceKey, userId) {
  return requestJson(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, serviceKey, { serverCredential: true });
}

async function readCatalogItem(baseUrl, serviceKey, itemId) {
  const query = `item_id=eq.${encodeURIComponent(itemId)}&active=eq.true&select=item_id,item_type,cost_coins,unlock_method&limit=1`;
  const rows = await requestJson(`${baseUrl}/rest/v1/store_catalog?${query}`, serviceKey, { serverCredential: true });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function probeRequiredIntegrationTables(baseUrl, serviceKey) {
  for (const [table, feature] of [["profiles", "Auth profiles"], ["store_catalog", "Store authority"], ["matchmaking_queue", "Quick Match matchmaking"], ["game_challenges", "Realtime game challenges"]]) {
    try {
      await requestJson(`${baseUrl}/rest/v1/${table}?select=*&limit=0`, serviceKey, { serverCredential: true });
    } catch (error) {
      fail(`${feature} migration surface is unavailable at public.${table}: ${error.message || error}`);
    }
  }
}

async function readProfile(baseUrl, serviceKey, userId) {
  const query = `id=eq.${encodeURIComponent(userId)}&select=id,public_id,username,avatar,country_flag,rating,coins,xp,wins,losses,draws,title&limit=1`;
  const rows = await requestJson(`${baseUrl}/rest/v1/profiles?${query}`, serviceKey, { serverCredential: true });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateProfile(baseUrl, serviceKey, userId, profile) {
  const query = `id=eq.${encodeURIComponent(userId)}`;
  const rows = await requestJson(`${baseUrl}/rest/v1/profiles?${query}`, serviceKey, {
    method: "PATCH",
    serverCredential: true,
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(profile)
  });
  if (!Array.isArray(rows) || rows.length !== 1) fail("the exact disposable E2E profile was not updated");
  return rows[0];
}

async function resetWallet(baseUrl, serviceKey, userId, label) {
  const updated = await updateProfile(baseUrl, serviceKey, userId, {
    coins: E2E_WALLET_BALANCE,
    updated_at: new Date().toISOString()
  });
  if (Number(updated?.coins) !== E2E_WALLET_BALANCE) {
    fail(`${label} wallet reset did not return the deterministic E2E balance`);
  }
  return Number(updated.coins);
}

async function equipDistinctiveNameStyle(baseUrl, serviceKey, userId, itemId) {
  const catalogQuery = `item_type=eq.nameStyle&active=eq.true&select=item_id&limit=96`;
  const catalog = await requestJson(`${baseUrl}/rest/v1/store_catalog?${catalogQuery}`, serviceKey, { serverCredential: true });
  const ids = Array.isArray(catalog) ? catalog.map((row) => String(row.item_id || "")).filter(Boolean) : [];
  if (!ids.includes(itemId)) fail(`required distinctive Name Style ${itemId} is missing from the active Store catalog`);
  const inFilter = `in.(${ids.join(",")})`;
  await requestJson(`${baseUrl}/rest/v1/user_inventory?user_id=eq.${encodeURIComponent(userId)}&item_id=${encodeURIComponent(inFilter)}`, serviceKey, {
    method: "PATCH",
    serverCredential: true,
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ equipped: false })
  });
  await requestJson(`${baseUrl}/rest/v1/user_inventory`, serviceKey, {
    method: "POST",
    serverCredential: true,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ user_id: userId, item_id: itemId, source: "migration", equipped: true })
  });
}

async function passwordLogin(baseUrl, anonKey, email, password) {
  return requestJson(`${baseUrl}/auth/v1/token?grant_type=password`, anonKey, {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

async function verifyStoreState(baseUrl, anonKey, accessToken, expectedItemId) {
  const state = await requestJson(`${baseUrl}/rest/v1/rpc/get_store_state`, anonKey, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: "{}"
  });
  const inventory = Array.isArray(state?.inventory) ? state.inventory : [];
  if (expectedItemId) {
    const equipped = inventory.find((item) => String(item.itemId || item.item_id || "") === expectedItemId && item.equipped);
    if (!equipped) fail(`authenticated Store state did not report ${expectedItemId} equipped`);
  }
  return { coins: Number(state?.coins) || 0, inventoryCount: inventory.length };
}

async function resolveExactUser(users, email, label, { requireGenerated = true, role = "" } = {}) {
  if (requireGenerated && !isGeneratedE2eEmail(email) && !isGeneratedPrimaryE2eEmail(email)) {
    fail(`refusing to modify a non-generated ${label} email`);
  }
  const matches = users.filter((candidate) => String(candidate.email || "").trim().toLowerCase() === String(email).toLowerCase());
  if (matches.length > 1) fail(`multiple Auth users match the exact generated ${label} email`);
  if (!matches.length) fail(`the exact generated ${label} Auth user was not found`);
  if (role) {
    const metadata = matches[0].user_metadata || {};
    if (metadata.e2e !== true || String(metadata.e2e_role || "") !== role) {
      fail(`the exact ${label} email exists but is not marked as the generated E2E ${role} account`);
    }
  }
  return matches[0];
}

async function main() {
  const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  if (!fs.existsSync(envFile) && !ci) fail(`the local ${path.basename(envFile)} file is missing; refusing to create a partial E2E configuration`);
  const values = readE2eValues();
  const target = envValue("E2E_ENVIRONMENT", values).toLowerCase();
  const explicitBaseUrl = envValue("E2E_SUPABASE_URL", values);
  const explicitAnonKey = envValue("E2E_SUPABASE_ANON_KEY", values);
  if (!safeTargetEnvironments.has(target)) fail("E2E_ENVIRONMENT must be local, development, test, or staging; production fixture targets are forbidden");
  if (!explicitBaseUrl) fail("E2E_SUPABASE_URL must be explicitly configured for the dedicated non-production project; production URL discovery is forbidden");
  if (!explicitAnonKey) fail("E2E_SUPABASE_ANON_KEY must be explicitly configured for the dedicated non-production project");
  const baseUrl = explicitBaseUrl.replace(/\/$/, "");
  const anonKey = explicitAnonKey;
  const adminCredential = resolveAdminCredential();
  const serviceKey = adminCredential?.key || "";
  if (!/^https:\/\/[^/]+\.supabase\.co$/i.test(baseUrl)) fail("a dedicated non-production Supabase HTTPS URL is required");
  if (!anonKey) fail("the public Supabase anon/publishable key is not discoverable");
  if (!serviceKey) fail("SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (legacy fallback) must be supplied only in the current shell; neither is read from or written to .env.e2e");
  await probeRequiredIntegrationTables(baseUrl, serviceKey);

  const configuredEmail = envValue("E2E_SECOND_EMAIL", values).toLowerCase();
  const configuredPassword = String(process.env.E2E_SECOND_PASSWORD || values.E2E_SECOND_PASSWORD || "");
  if ((configuredEmail && !configuredPassword) || (!configuredEmail && configuredPassword)) fail("E2E_SECOND_EMAIL and E2E_SECOND_PASSWORD must be configured together, or both left empty");
  if (configuredEmail && !isGeneratedE2eEmail(configuredEmail)) fail("refusing to modify a non-generated Account B email; use nschess-e2e-b-<hex>@proton.me");

  const suffix = configuredEmail ? safeEmailLocal(configuredEmail).replace(/^nschess-e2e-b-/, "") : crypto.randomBytes(6).toString("hex");
  const email = configuredEmail || `nschess-e2e-b-${suffix}@proton.me`;
  const password = configuredPassword || `NscE2E-B!${crypto.randomBytes(18).toString("base64url")}`;
  const username = `e2e_b_${suffix.slice(0, 12)}`;
  const publicId = `e2e_b_${suffix.slice(0, 24)}`;
  const nameStyleItem = "name-violet";
  const nameStyleValue = "violet";

  const primaryEmail = envValue("E2E_EMAIL", values).toLowerCase();
  const primaryPassword = String(process.env.E2E_PASSWORD || values.E2E_PASSWORD || "");
  if (!primaryEmail || !primaryPassword) fail("E2E_EMAIL and E2E_PASSWORD must be configured for the dedicated primary account");
  if (!isGeneratedPrimaryE2eEmail(primaryEmail)) fail("refusing to modify a non-generated primary E2E email; use nschess-e2e-<8 hex>@proton.me");
  if (!Number.isSafeInteger(E2E_WALLET_BALANCE) || E2E_WALLET_BALANCE <= 0) fail("the deterministic E2E wallet balance is invalid");

  const nameStyle = await readCatalogItem(baseUrl, serviceKey, nameStyleItem);
  if (!nameStyle || nameStyle.item_type !== "nameStyle") fail(`active Store catalog item ${nameStyleItem} is unavailable`);
  const users = await listAdminUsers(baseUrl, serviceKey);
  const primaryUser = await resolveExactUser(users, primaryEmail, "primary E2E");

  if (fixtureOnly) {
    const secondaryEmail = configuredEmail;
    if (!secondaryEmail || !configuredPassword) fail("fixture-only reset requires the already-provisioned generated Account B credentials");
    const secondaryUser = await resolveExactUser(users, secondaryEmail, "secondary E2E", { role: "account_b" });
    const primaryFixtureProfile = await updateProfile(baseUrl, serviceKey, primaryUser.id, {
      rating: E2E_PRIMARY_MATCHMAKING_RATING,
      updated_at: new Date().toISOString()
    });
    if (Number(primaryFixtureProfile?.rating) !== E2E_PRIMARY_MATCHMAKING_RATING) {
      fail("fixture-only reset did not set the canonical Account A matchmaking rating");
    }
    const fixtureProfile = await updateProfile(baseUrl, serviceKey, secondaryUser.id, {
      username,
      display_name: username,
      avatar: "♞",
      country_flag: "JP",
      title: "E2E B Marshal",
      rating: E2E_SECONDARY_MATCHMAKING_RATING,
      coins: E2E_WALLET_BALANCE,
      xp: 840,
      wins: 7,
      losses: 2,
      draws: 1,
      updated_at: new Date().toISOString()
    });
    if (Number(fixtureProfile?.coins) !== E2E_WALLET_BALANCE
      || Number(fixtureProfile?.xp) !== 840
      || Number(fixtureProfile?.rating) !== E2E_SECONDARY_MATCHMAKING_RATING) {
      fail("fixture-only reset did not return the canonical Account B profile baseline");
    }
    await equipDistinctiveNameStyle(baseUrl, serviceKey, secondaryUser.id, nameStyleItem);
    const session = await passwordLogin(baseUrl, anonKey, secondaryEmail, configuredPassword);
    const store = await verifyStoreState(baseUrl, anonKey, session.access_token, nameStyleItem);
    if (Number(store?.coins) !== E2E_WALLET_BALANCE) fail("fixture-only reset did not verify the canonical Account B wallet through the authenticated Store RPC");
    console.log(JSON.stringify({
      result: "Dedicated E2E Account B fixture reset and verified",
      accountBAuthUserId: mask(secondaryUser.id),
      profileBaseline: {
        accountARating: E2E_PRIMARY_MATCHMAKING_RATING,
        accountBRating: E2E_SECONDARY_MATCHMAKING_RATING,
        xp: 840,
        coins: E2E_WALLET_BALANCE,
        title: "E2E B Marshal"
      },
      accountScope: "only the generated E2E primary and secondary accounts"
    }, null, 2));
    return;
  }

  if (walletOnly) {
    const secondaryEmail = configuredEmail;
    if (!secondaryEmail || !configuredPassword) fail("wallet-only reset requires the already-provisioned generated Account B credentials");
    const secondaryUser = await resolveExactUser(users, secondaryEmail, "secondary E2E", { role: "account_b" });
    const primaryBalance = await resetWallet(baseUrl, serviceKey, primaryUser.id, "primary E2E");
    const secondaryBalance = await resetWallet(baseUrl, serviceKey, secondaryUser.id, "secondary E2E");
    const primarySession = await passwordLogin(baseUrl, anonKey, primaryEmail, primaryPassword);
    const secondarySession = await passwordLogin(baseUrl, anonKey, secondaryEmail, configuredPassword);
    const primaryStore = await verifyStoreState(baseUrl, anonKey, primarySession.access_token, "");
    const secondaryStore = await verifyStoreState(baseUrl, anonKey, secondarySession.access_token, nameStyleItem);
    if (primaryBalance !== E2E_WALLET_BALANCE || secondaryBalance !== E2E_WALLET_BALANCE
      || Number(primaryStore?.coins) !== E2E_WALLET_BALANCE || Number(secondaryStore.coins) !== E2E_WALLET_BALANCE) {
      fail("wallet-only reset verification did not observe the deterministic balance through the authenticated Store RPC");
    }
    console.log(JSON.stringify({
      result: "Dedicated E2E wallets reset through Supabase Auth Admin + authoritative Store verification",
      primaryAuthUserId: mask(primaryUser.id),
      secondaryAuthUserId: mask(secondaryUser.id),
      primaryCoins: primaryBalance,
      secondaryCoins: secondaryBalance,
      walletBalance: E2E_WALLET_BALANCE,
      accountScope: "only generated E2E primary and secondary emails"
    }, null, 2));
    return;
  }

  const matches = users.filter((user) => String(user.email || "").trim().toLowerCase() === email);
  if (matches.length > 1) fail("multiple Auth users match the exact generated Account B email");
  if (matches.length === 1) {
    const metadata = matches[0].user_metadata || {};
    if (metadata.e2e !== true || String(metadata.e2e_role || "") !== "account_b") {
      fail("the generated Account B email already belongs to an unmarked Auth user; refusing to modify it");
    }
  }

  let user;
  let action;
  const metadata = { username, e2e: true, e2e_account: "secondary", e2e_role: "account_b" };
  if (!matches.length) {
    user = await requestJson(`${baseUrl}/auth/v1/admin/users`, serviceKey, {
      method: "POST",
      serverCredential: true,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata })
    });
    action = "created";
  } else {
    const existing = matches[0];
    user = await requestJson(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(existing.id)}`, serviceKey, {
      method: "PUT",
      serverCredential: true,
      body: JSON.stringify({
        password,
        email_confirm: true,
        user_metadata: { ...(existing.user_metadata || {}), ...metadata }
      })
    });
    action = "reset";
  }
  const userId = String(user?.id || matches[0]?.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) fail("Supabase Admin Auth did not return a valid Account B user ID");
  if (userId === String(primaryUser.id || "")) fail("the generated Account B resolved to the generated primary account; refusing to continue because fixture isolation is not proven");

  const confirmedPayload = await readAdminUser(baseUrl, serviceKey, userId);
  const confirmedUser = confirmedPayload?.user || confirmedPayload;
  const confirmedMetadata = confirmedUser?.user_metadata || {};
  if (!confirmedUser?.email_confirmed_at) fail("Account B was not email-confirmed by the Auth Admin provisioning response");
  if (confirmedMetadata.e2e !== true || String(confirmedMetadata.e2e_role || "") !== "account_b") {
    fail("Account B Auth metadata is missing the required generated E2E marker");
  }

  const profile = await readProfile(baseUrl, serviceKey, userId);
  if (!profile) fail("Auth succeeded but the auth.users → public.profiles trigger did not create Account B's profile; apply the project auth migration before retrying");
  const updatedProfile = await updateProfile(baseUrl, serviceKey, userId, {
    public_id: publicId,
    username,
    display_name: username,
    avatar: "♞",
    country_flag: "JP",
    title: "E2E B Marshal",
    rating: E2E_SECONDARY_MATCHMAKING_RATING,
    coins: E2E_WALLET_BALANCE,
    xp: 840,
    wins: 7,
    losses: 2,
    draws: 1,
    updated_at: new Date().toISOString()
  });
  if (Number(updatedProfile?.rating) !== E2E_SECONDARY_MATCHMAKING_RATING) {
    fail("Account B profile baseline did not persist the canonical matchmaking rating");
  }
  await equipDistinctiveNameStyle(baseUrl, serviceKey, userId, nameStyleItem);
  const session = await passwordLogin(baseUrl, anonKey, email, password);
  const store = await verifyStoreState(baseUrl, anonKey, session.access_token, nameStyleItem);
  const primaryFixtureProfile = await updateProfile(baseUrl, serviceKey, primaryUser.id, {
    rating: E2E_PRIMARY_MATCHMAKING_RATING,
    updated_at: new Date().toISOString()
  });
  if (Number(primaryFixtureProfile?.rating) !== E2E_PRIMARY_MATCHMAKING_RATING) {
    fail("primary E2E fixture did not receive the canonical matchmaking rating");
  }
  const primaryBalance = await resetWallet(baseUrl, serviceKey, primaryUser.id, "primary E2E");
  const primarySession = await passwordLogin(baseUrl, anonKey, primaryEmail, primaryPassword);
  const primaryStore = await verifyStoreState(baseUrl, anonKey, primarySession.access_token, "");
  if (primaryBalance !== E2E_WALLET_BALANCE || Number(primaryStore.coins) !== E2E_WALLET_BALANCE) {
    fail("primary E2E wallet reset did not verify through the authenticated Store RPC");
  }

  writeEnvValue(envFile, "E2E_SECOND_EMAIL", email);
  writeEnvValue(envFile, "E2E_SECOND_PASSWORD", password);
  writeEnvValue(envFile, "E2E_SECOND_EXPECTED_NAME_STYLE", nameStyleValue);
  console.log(JSON.stringify({
    result: `${environmentCheck ? "Environment check created/reset" : "Account B"} through Supabase Auth Admin API`,
    accountB: {
      email,
      password: "stored only in ignored .env.e2e; not printed",
      displayName: updatedProfile.username
    },
    verified: {
      emailConfirmed: true,
      profileCreated: true,
      generatedMarker: true,
      nameStyle: nameStyleItem,
      accountBCoins: Number(updatedProfile.coins),
      accountACoins: primaryBalance,
      matchmakingRatings: {
        primary: E2E_PRIMARY_MATCHMAKING_RATING,
        secondary: E2E_SECONDARY_MATCHMAKING_RATING
      },
      authenticatedStoreCoins: store.coins
    },
    localCredentialFile: path.relative(root, envFile)
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, status: error.status || 0, code: error.code || "" }, null, 2));
  process.exitCode = 1;
});
