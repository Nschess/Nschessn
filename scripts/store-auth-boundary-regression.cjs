const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { parseEnvFile, discoverSupabaseConfig } = require("./e2e-config.cjs");
const { run: runTestEnvironment } = require("./test-environment.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");
const environmentPreflighted = process.argv.includes("--environment-preflighted") || process.env.NSCHESS_ENVIRONMENT_PRECHECKED === "1";
for (const [key, value] of Object.entries(parseEnvFile(envFile))) {
  if (["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"].includes(key)) continue;
  if (!String(process.env[key] || "").trim()) process.env[key] = value;
}

const port = Number(process.env.E2E_PORT || 4173);
const baseUrl = (process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const local = /localhost|127\.0\.0\.1/i.test(baseUrl);
const tempFiles = [];

function redact(id) {
  const value = String(id || "");
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "";
}

function requireEnv(name) {
  if (!String(process.env[name] || "").trim()) throw new Error(`${name} is not configured in ${envFile}.`);
  return process.env[name];
}

async function waitForLocalServer() {
  const deadline = Date.now() + 15000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth-config`, { cache: "no-store" });
      if (response.ok) return;
      lastError = `auth-config returned ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local E2E server did not become ready: ${lastError}`);
}

async function gotoHash(page, hash) {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
}

async function readUserId(page) {
  return page.evaluate(async () => {
    const client = window.CheckmateQuestSupabaseClient?.client;
    const result = await client?.auth?.getUser?.();
    return String(result?.data?.user?.id || "");
  });
}

async function waitForAuthenticated(page, label) {
  try {
    await page.waitForFunction(async () => {
      const client = window.CheckmateQuestSupabaseClient?.client;
      const result = await client?.auth?.getSession?.();
      return document.documentElement.dataset.authState === "authenticated"
        && !document.getElementById("authAccountPanel")?.hidden
        && Boolean(result?.data?.session?.user?.id);
    }, null, { timeout: 15000 });
  } catch (error) {
    throw new Error(`${label} did not reach a live authenticated session: ${error.message}`);
  }
}

async function waitForStore(page, label) {
  await page.waitForFunction(() => document.documentElement.dataset.storeSyncStatus === "ready", null, { timeout: 15000 })
    .catch(async (error) => {
      const status = await page.evaluate(() => ({
        authState: document.documentElement.dataset.authState || "",
        storeSyncStatus: document.documentElement.dataset.storeSyncStatus || "",
        message: document.getElementById("storeStatus")?.textContent || ""
      }));
      throw new Error(`${label} Store hydration failed: ${JSON.stringify({ timeout: error.message, status })}`);
    });
}

async function login(page, email, password, label) {
  await page.locator('[data-auth-tab="login"]').click({ noWaitAfter: true });
  await page.locator("#authLoginEmail").fill(email);
  await page.locator("#authLoginPassword").fill(password);
  await page.locator("#authLoginForm button[type='submit']").click();
  await waitForAuthenticated(page, label);
}

async function logout(page, label) {
  await page.locator("#authPanelLogout").click({ noWaitAfter: true });
  await page.waitForFunction(async () => {
    const client = window.CheckmateQuestSupabaseClient?.client;
    const result = await client?.auth?.getSession?.();
    return document.documentElement.dataset.authState === "guest"
      && document.getElementById("authAccountPanel")?.hidden === true
      && !result?.data?.session?.user?.id;
  }, null, { timeout: 15000 }).catch((error) => {
    throw new Error(`${label} did not reach a clean signed-out state: ${error.message}`);
  });
}

async function main() {
  if (!environmentPreflighted) {
    await runTestEnvironment();
    process.env.NSCHESS_ENVIRONMENT_PRECHECKED = "1";
  }
  const accountAEmail = requireEnv("E2E_EMAIL");
  const accountAPassword = requireEnv("E2E_PASSWORD");
  const accountBEmail = requireEnv("E2E_SECOND_EMAIL");
  const accountBPassword = requireEnv("E2E_SECOND_PASSWORD");
  const config = discoverSupabaseConfig();
  if (!config.hasUrl || !config.hasAnonKey) throw new Error("Public Supabase URL/anon key is not configured for the E2E server.");

  let server = null;
  let browser = null;
  let initialContext = null;
  let staleContext = null;
  let isolationContext = null;
  let freshContext = null;
  let initialState = "";
  let restoredState = "";

  try {
    if (local) {
      server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
      await waitForLocalServer();
    }
    browser = await chromium.launch({ headless: true });

    initialContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
    const initialPage = await initialContext.newPage();
    await gotoHash(initialPage, "#login");
    await login(initialPage, accountAEmail, accountAPassword, "initial Account A login");
    await waitForStore(initialPage, "initial Account A");
    const accountAId = await readUserId(initialPage);
    initialState = path.join(os.tmpdir(), `nschess-initial-a-${process.pid}.json`);
    tempFiles.push(initialState);
    await initialContext.storageState({ path: initialState });
    await initialContext.close();
    initialContext = null;

    staleContext = await browser.newContext({ storageState: initialState, viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
    const stalePage = await staleContext.newPage();
    await gotoHash(stalePage, "#login");
    await waitForAuthenticated(stalePage, "stale Account A context");

    isolationContext = await browser.newContext({ storageState: initialState, viewport: { width: 1024, height: 800 }, serviceWorkers: "allow" });
    const isolationPage = await isolationContext.newPage();
    await gotoHash(isolationPage, "#login");
    await waitForAuthenticated(isolationPage, "Account A before logout");
    await logout(isolationPage, "Account A logout");

    await login(isolationPage, accountBEmail, accountBPassword, "Account B login");
    await waitForStore(isolationPage, "Account B");
    const accountBId = await readUserId(isolationPage);
    if (!accountAId || !accountBId || accountAId === accountBId) throw new Error("Account A/B isolation did not produce distinct users.");
    await logout(isolationPage, "Account B logout");

    await login(isolationPage, accountAEmail, accountAPassword, "Account A restore login");
    await waitForStore(isolationPage, "Account A restore");
    if (await readUserId(isolationPage) !== accountAId) throw new Error("Account A did not restore after Account B logout.");

    restoredState = path.join(os.tmpdir(), `nschess-restored-a-${process.pid}.json`);
    tempFiles.push(restoredState);
    await isolationContext.storageState({ path: restoredState });
    if (!fs.existsSync(restoredState) || fs.statSync(restoredState).size === 0) throw new Error("Restored Account A storage state was not persisted.");

    await isolationContext.close();
    isolationContext = null;
    await staleContext.close();
    staleContext = null;

    freshContext = await browser.newContext({ storageState: restoredState, viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
    const freshPage = await freshContext.newPage();
    await gotoHash(freshPage, "#login");
    await waitForAuthenticated(freshPage, "fresh Account A context");
    await waitForStore(freshPage, "fresh Account A Store");

    const proof = await freshPage.evaluate(async () => {
      const client = window.CheckmateQuestSupabaseClient?.client;
      const session = await client.auth.getSession();
      const user = await client.auth.getUser();
      const store = await client.rpc("get_store_state");
      return {
        sessionUserId: String(session?.data?.session?.user?.id || ""),
        authUserId: String(user?.data?.user?.id || ""),
        rpcError: store?.error?.message || "",
        catalogCount: Array.isArray(store?.data?.catalog) ? store.data.catalog.length : -1,
        inventoryCount: Array.isArray(store?.data?.inventory) ? store.data.inventory.length : -1
      };
    });
    if (proof.sessionUserId !== accountAId || proof.authUserId !== accountAId || proof.rpcError) {
      throw new Error(JSON.stringify({ sessionMatchesAccountA: proof.sessionUserId === accountAId, authUserMatchesAccountA: proof.authUserId === accountAId, rpcError: proof.rpcError }));
    }

    console.log(JSON.stringify({
      result: "PASS",
      restoredStatePersisted: true,
      stalePurchaseContextClosed: true,
      freshContextCreated: true,
      accountA: redact(accountAId),
      freshSessionMatchesAccountA: true,
      protectedStoreRpcSucceeded: true,
      catalogCount: proof.catalogCount,
      inventoryCount: proof.inventoryCount
    }, null, 2));
  } finally {
    await freshContext?.close().catch(() => {});
    await isolationContext?.close().catch(() => {});
    await staleContext?.close().catch(() => {});
    await initialContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server?.kill();
    tempFiles.forEach((file) => { try { fs.unlinkSync(file); } catch {} });
  }
}

main().catch((error) => {
  if (error.status === "BLOCKED/ENVIRONMENT") {
    console.error(error.message || error);
    process.exitCode = error.exitCode || 2;
    return;
  }
  console.error(`FAIL: TARGETED STORE/AUTH BOUNDARY: ${error.message}`);
  process.exitCode = 1;
});
