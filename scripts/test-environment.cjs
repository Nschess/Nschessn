/*
 * Permanent Nschess integration-test environment gate.
 *
 * This is intentionally a separate process from the tests. A live test must
 * never start its browser, database, Realtime, or fixture work until this
 * gate has established that the complete disposable environment is usable.
 * The only credential accepted from a file is the public E2E configuration;
 * privileged Supabase credentials must be present in the invoking process.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { spawnSync } = require("child_process");
const { parseEnvFile } = require("./e2e-config.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");
const protectedNames = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const generatedPrimary = /^nschess-e2e-[a-f0-9]{8}@proton\.me$/i;
const generatedSecondary = /^nschess-e2e-b-[a-f0-9]{8,32}@proton\.me$/i;
const safeTargetEnvironments = new Set(["local", "development", "test", "staging"]);

class EnvironmentBlockedError extends Error {
  constructor(messages) {
    super(messages.join("\n"));
    this.name = "EnvironmentBlockedError";
    this.status = "BLOCKED/ENVIRONMENT";
    this.messages = messages;
    this.exitCode = 2;
  }
}

function value(name, values = {}) {
  return String(process.env[name] || values[name] || "").trim();
}

function isPlaceholder(valueToCheck) {
  return /(?:replace-with|dedicated-test-password|e2e-primary@example\.com|e2e-secondary@example\.com)/i.test(String(valueToCheck || ""));
}

function loadPublicEnvironment() {
  const values = fs.existsSync(envFile) ? parseEnvFile(envFile) : {};
  for (const [name, configuredValue] of Object.entries(values)) {
    // A server-only credential in .env.e2e is always a configuration error,
    // even when a safer process credential is also present.
    if (protectedNames.includes(name)) continue;
    if (process.env[name] === undefined && String(configuredValue || "").trim()) process.env[name] = configuredValue;
  }
  return values;
}

function protectedFileIssues(values) {
  const issues = [];
  const candidateFiles = [envFile, path.join(root, ".env"), path.join(root, ".env.local"), path.join(root, ".env.example"), path.join(root, ".env.e2e.example")];
  for (const file of candidateFiles) {
    const fileValues = file === envFile ? values : fs.existsSync(file) ? parseEnvFile(file) : {};
    for (const name of protectedNames) {
      if (String(fileValues[name] || "").trim()) issues.push(`${name} is present in ${file}. Remove it; keep privileged keys only in the current server-side shell or CI secret store.`);
    }
  }
  return issues;
}

function trackedCredentialFileIssues() {
  const result = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  const forbidden = (result.stdout || "").split(/\r?\n/).map((file) => file.trim()).filter((file) => /^\.env(?:$|\.local$|\.e2e$)|(^|\/)\.env(?:$|\.local$|\.e2e$)/i.test(file));
  return forbidden.length ? [`Tracked credential environment file(s) are forbidden: ${forbidden.join(", ")}. Keep only .env.example and .env.e2e.example templates under version control.`] : [];
}

function requiredConfiguration(values, { requireSecondary = true } = {}) {
  const issues = [...protectedFileIssues(values), ...trackedCredentialFileIssues()];
  const target = value("E2E_ENVIRONMENT", values).toLowerCase();
  const baseUrl = value("E2E_BASE_URL", values);
  const supabaseUrl = value("E2E_SUPABASE_URL", values);
  const anonKey = value("E2E_SUPABASE_ANON_KEY", values);
  const primaryEmail = value("E2E_EMAIL", values).toLowerCase();
  const primaryPassword = String(process.env.E2E_PASSWORD || values.E2E_PASSWORD || "");
  const secondaryEmail = value("E2E_SECOND_EMAIL", values).toLowerCase();
  const secondaryPassword = String(process.env.E2E_SECOND_PASSWORD || values.E2E_SECOND_PASSWORD || "");
  const realtimeEnabled = value("E2E_REALTIME_ENABLED", values);
  const adminKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const missing = [];

  if (!target) missing.push("E2E_ENVIRONMENT");
  if (!baseUrl) missing.push("E2E_BASE_URL");
  if (!supabaseUrl) missing.push("E2E_SUPABASE_URL");
  if (!anonKey) missing.push("E2E_SUPABASE_ANON_KEY");
  if (!primaryEmail) missing.push("E2E_EMAIL");
  if (!primaryPassword) missing.push("E2E_PASSWORD");
  if (!adminKey) missing.push("SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY");
  if (realtimeEnabled !== "1") missing.push("E2E_REALTIME_ENABLED=1");

  const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const secondaryPairMissing = !secondaryEmail && !secondaryPassword;
  if (requireSecondary && !secondaryPairMissing) {
    if (!secondaryEmail) missing.push("E2E_SECOND_EMAIL");
    if (!secondaryPassword) missing.push("E2E_SECOND_PASSWORD");
  } else if (requireSecondary && ci && secondaryPairMissing) {
    missing.push("E2E_SECOND_EMAIL");
    missing.push("E2E_SECOND_PASSWORD");
  }

  if (target && !safeTargetEnvironments.has(target)) {
    issues.push(`E2E_ENVIRONMENT=${target} is not an allowed disposable target. Use local, development, test, or staging; production fixtures are forbidden.`);
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) issues.push("E2E_BASE_URL must be an http(s) URL, for example http://127.0.0.1:4173.");
  if (supabaseUrl && !/^https:\/\/[^/]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
    issues.push("E2E_SUPABASE_URL must be the dedicated non-production Supabase HTTPS project URL.");
  }
  if (primaryEmail && !generatedPrimary.test(primaryEmail)) {
    issues.push("E2E_EMAIL must be the generated disposable form nschess-e2e-<8 hex>@proton.me; personal or production accounts are forbidden.");
  }
  if (primaryPassword && isPlaceholder(primaryPassword)) issues.push("E2E_PASSWORD is still a placeholder; configure the dedicated disposable primary account password.");
  if (secondaryEmail && !generatedSecondary.test(secondaryEmail)) {
    issues.push("E2E_SECOND_EMAIL must be the generated disposable form nschess-e2e-b-<hex>@proton.me; personal or production accounts are forbidden.");
  }
  if (secondaryPassword && isPlaceholder(secondaryPassword)) issues.push("E2E_SECOND_PASSWORD is still a placeholder; configure the dedicated disposable secondary account password.");
  if ((secondaryEmail && !secondaryPassword) || (!secondaryEmail && secondaryPassword)) {
    issues.push("E2E_SECOND_EMAIL and E2E_SECOND_PASSWORD must be configured together, or both left empty so the local preflight can create Account B.");
  }

  return {
    issues,
    missing,
    ci,
    target,
    baseUrl,
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    anonKey,
    primaryEmail,
    primaryPassword,
    secondaryEmail,
    secondaryPassword,
    adminKey,
    requireSecondary
  };
}

function block(configuration) {
  const messages = [...configuration.issues];
  if (configuration.missing.length) {
    messages.push(`Missing required integration-test configuration: ${configuration.missing.join(", ")}.`);
    messages.push(`Configure public E2E values in ${envFile}; set SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY only in the current server-side shell, and configure CI values as repository/environment secrets. Never put a privileged key in ${envFile}. Then rerun \`npm.cmd run test:environment\`.`);
  }
  if (!messages.length) messages.push("The disposable integration environment did not satisfy its contract.");
  throw new EnvironmentBlockedError(messages.map((message) => `BLOCKED/ENVIRONMENT: ${message}`));
}

function runProvisioning() {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "provision-e2e-account.cjs"), "--environment-check"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw new EnvironmentBlockedError([`BLOCKED/ENVIRONMENT: disposable E2E account validation could not start: ${result.error.message}`]);
  if (result.status !== 0) throw new EnvironmentBlockedError(["BLOCKED/ENVIRONMENT: disposable E2E account/fixture validation failed. Confirm the dedicated non-production Supabase project has the required Auth, profile, Store, matchmaking, migration, and RLS setup, then rerun `npm.cmd run test:environment`."]);
}

async function checkRealtime(configuration) {
  const endpoint = `${configuration.supabaseUrl}/realtime/v1/websocket?apikey=${encodeURIComponent(configuration.anonKey)}&vsn=1.0.0`;
  await new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const request = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64")
      }
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("Realtime websocket did not open within 10 seconds."));
    }, 10000);
    request.once("upgrade", (_response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    request.once("response", (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`Realtime websocket handshake returned HTTP ${response.statusCode}.`));
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  }).catch((error) => {
    throw new EnvironmentBlockedError([`BLOCKED/ENVIRONMENT: Realtime preflight failed for the dedicated Supabase project: ${error.message} Apply the Realtime publication/migration setup and rerun \`npm.cmd run test:environment\`.`]);
  });
}

function refreshConfiguration() {
  const values = loadPublicEnvironment();
  return { values, configuration: requiredConfiguration(values) };
}

async function run() {
  const values = loadPublicEnvironment();
  let configuration = requiredConfiguration(values);
  // Account B may be generated once locally by the setup check. CI must
  // receive both account credentials as secrets so missing CI configuration
  // remains an explicit blocked result rather than an implicit account write.
  if (configuration.missing.length || configuration.issues.length) {
    const onlyLocalBootstrap = !configuration.ci
      && configuration.missing.every((name) => name === "E2E_SECOND_EMAIL" || name === "E2E_SECOND_PASSWORD")
      && configuration.issues.length === 0;
    if (!onlyLocalBootstrap) block(configuration);
  }

  if (!configuration.secondaryEmail && !configuration.secondaryPassword) {
    console.log("INFO  test environment: local preflight will create the generated disposable Account B fixture");
  }
  runProvisioning();
  ({ configuration } = refreshConfiguration());
  if (configuration.missing.length || configuration.issues.length) block(configuration);
  await checkRealtime(configuration);
  console.log("PASS  test environment: dedicated non-production Supabase, two disposable accounts, reset/isolation, migrations, and Realtime are ready");
  console.log("PASS  test environment: no production fixture path or file-stored privileged credential was accepted");
}

if (require.main === module) {
  run().catch((error) => {
    const status = error.status || "FAIL";
    console.error(error.status === "BLOCKED/ENVIRONMENT" ? error.message : `${status}: ${error.message || error}`);
    process.exitCode = error.exitCode || 1;
  });
}

module.exports = { EnvironmentBlockedError, loadPublicEnvironment, requiredConfiguration, run };
