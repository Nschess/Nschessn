/* Offline safety proofs. Real entry-point source runs in a VM with isolated
 * configuration and tripwires for network, subprocesses, and file writes.
 * No live runner, browser, database, or credential-bearing process is started.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const root = path.resolve(__dirname, "..");
const productionRef = "jfrvoykwowzthlvzwsmi";
const candidateRef = "abcdefghijklmnopqrst";
const productionUrl = `https://${productionRef}.supabase.co`;
const candidateUrl = `https://${candidateRef}.supabase.co`;
const checkedInRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, "e2e-approved-projects.json"), "utf8"));
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function sandbox({ env = {}, registry = checkedInRegistry, files = {}, recordFixtureDeletes = false, fixtureRows = {}, fixtureReadFailure = "", pageSize = 100, staticFiles, localServer } = {}) {
  const effects = { requests: [], subprocesses: 0, writes: 0, reads: [], output: [], servers: [], staticChecks: [], gitReads: 0, serverKilled: false };
  const database = JSON.parse(JSON.stringify(fixtureRows));
  let spawnedServer;
  let spawnedEnv;
  const cache = new Map();
  const virtualFiles = new Map(Object.entries(files).map(([name, text]) => [path.resolve(root, name), text]));
  const fakeProcess = { env: { ...env }, argv: [], execPath: process.execPath, exitCode: 0, on() {}, once() {}, stdout: { write() {} }, stderr: { write() {} } };
  let entry;
  const forbidden = (kind) => () => {
    effects[kind] += 1;
    throw new Error(`Offline tripwire: ${kind}`);
  };
  const network = (url) => {
    effects.requests.push({ url: String(url) });
    throw new Error("Offline tripwire: network");
  };
  const fakeFs = {
    existsSync: (name) => virtualFiles.has(path.resolve(name)),
    readFileSync(name) {
      effects.reads.push(path.resolve(name));
      if (!virtualFiles.has(path.resolve(name))) throw new Error("Offline tripwire: unexpected file read");
      return virtualFiles.get(path.resolve(name));
    },
    mkdirSync: forbidden("writes"), mkdtempSync: forbidden("writes"),
    writeFileSync: forbidden("writes"), copyFileSync: forbidden("writes"), unlinkSync: forbidden("writes")
  };
  const fakeHttp = {
    request: network, get: network,
    createServer(handler) {
      effects.servers.push(handler);
      return { listen() {}, close() {} };
    }
  };
  if (localServer) fakeHttp.get = (url, receive) => {
    effects.requests.push({ url: String(url), method: "GET" });
    assert.equal(new URL(url).origin, "http://127.0.0.1:4173", "readiness escaped the loopback server");
    const request = new EventEmitter();
    request.destroy = () => {};
    request.setTimeout = () => {};
    setImmediate(() => {
      if (localServer.spawnError) return spawnedServer.emit("error", new Error("unit spawn failure"));
      const response = new EventEmitter();
      response.setEncoding = () => {};
      response.statusCode = localServer.status || 200;
      receive(response);
      response.emit("data", JSON.stringify({ url: candidateUrl, anonKey: "unit-public-key", e2eServerInstance: spawnedEnv.E2E_SERVER_INSTANCE_ID, ...localServer.config }));
      response.emit("end");
    });
    return request;
  };
  const fakeFetch = async (url, options = {}) => {
    const method = options.method || "GET";
    effects.requests.push({ url: String(url), method });
    if (!recordFixtureDeletes || !["GET", "DELETE"].includes(method)) throw new Error("Offline tripwire: network");
    const parsed = new URL(url);
    assert.equal(parsed.origin, candidateUrl, "fixture request escaped approved unit target");
    const table = parsed.pathname.split("/").pop();
    if (table === fixtureReadFailure && method === "GET") throw new Error("unit child inspection denied");
    const filters = [...parsed.searchParams].filter(([key]) => !["select", "order", "limit"].includes(key))
      .map(([key, value]) => key === "and" || key === "or" ? `${key}${value}` : `${key}.${value}`);
    const selected = (database[table] || []).filter((row) => filters.every((filter) => matches(row, filter)));
    if (method === "GET") {
      selected.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const limit = Math.min(pageSize, Number(parsed.searchParams.get("limit") || 100));
      return { ok: true, status: 200, text: async () => JSON.stringify(selected.slice(0, limit)) };
    }
    database[table] = (database[table] || []).filter((row) => !selected.includes(row));
    if (table === "game_challenges") {
      for (const child of ["game_challenge_messages", "game_challenge_presence", "game_challenge_validation_events"]) {
        database[child] = (database[child] || []).filter((row) => !selected.some((parent) => parent.id === row.challenge_id));
      }
    }
    return { ok: true, status: 204, text: async () => "" };
  };
  const fakeSubprocess = {
    spawn: forbidden("subprocesses"),
    spawnSync(command, args) {
      if (!staticFiles) return forbidden("subprocesses")();
      if (command === "git") {
        assert(["diff --name-only HEAD", "status --porcelain", "diff --check"].includes(args.join(" ")));
        effects.gitReads += 1;
        return { status: 0, stdout: args.includes("--name-only") ? staticFiles.join("\n") : "" };
      }
      assert.equal(command, process.execPath);
      assert(args[0] === "--check" || ["scripts/e2e-safety-regression.cjs", "scripts/oauth-auth-regression.js", "scripts/auth-logout-regression.js", "scripts/board-interaction-regression.js", "scripts/verify-site.js"].includes(args[0]), "static affected attempted a live subprocess");
      effects.staticChecks.push(args.join(" "));
      return { status: 0 };
    }
  };
  if (localServer) fakeSubprocess.spawn = (command, args, options) => {
    effects.subprocesses += 1;
    assert.equal(command, process.execPath);
    assert.equal(args[0], path.join(root, "scripts/e2e-server.cjs"));
    spawnedEnv = options.env;
    spawnedServer = new EventEmitter();
    spawnedServer.exitCode = null;
    spawnedServer.kill = () => { effects.serverKilled = true; };
    return spawnedServer;
  };

  function load(filename, { main = false, args = [] } = {}) {
    const absolute = path.resolve(root, filename);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    if (main) {
      entry = module;
      fakeProcess.argv = [process.execPath, absolute, ...args];
    }
    function localRequire(name) {
      if (name === "./e2e-approved-projects.json") return [...registry];
      if (name.startsWith("./")) return load(path.relative(root, path.resolve(path.dirname(absolute), name)));
      if (name === "fs") return fakeFs;
      if (name === "http" || name === "https") return fakeHttp;
      if (name === "child_process") return fakeSubprocess;
      if (name === "playwright") return { chromium: { launch: forbidden("subprocesses") } };
      if (["path", "crypto", "os"].includes(name)) return require(name);
      throw new Error(`Offline tripwire: unexpected module ${name}`);
    }
    localRequire.main = entry;
    const context = vm.createContext({
      module, exports: module.exports, require: localRequire,
      __dirname: path.dirname(absolute), __filename: absolute, process: fakeProcess,
      URL, Buffer, fetch: fakeFetch,
      console: { log: (...args) => effects.output.push(args.join(" ")), error: (...args) => effects.output.push(args.join(" ")) },
      setTimeout: localServer ? setTimeout : () => { throw new Error("Offline tripwire: timer before identity rejection"); }, clearTimeout
    });
    vm.runInContext(fs.readFileSync(absolute, "utf8"), context, { filename: absolute, timeout: 2000 });
    return module.exports;
  }
  return { load, effects, process: fakeProcess, database };
}

function expectBlocked(action, message) {
  assert.throws(action, (error) => error.code === "E2E_PROJECT_NOT_APPROVED"
    && error.status === "BLOCKED/ENVIRONMENT" && error.exitCode === 2 && (!message || message.test(error.message)));
}

function assertNoEffects(harness) {
  assert.equal(harness.effects.requests.length, 0, "request happened before rejection");
  assert.equal(harness.effects.subprocesses, 0, "provisioning/browser/subprocess happened before rejection");
  assert.equal(harness.effects.writes, 0, "filesystem mutation happened before rejection");
}

// Interpret the small PostgREST filter subset actually emitted by cleanup.
// This evaluates the emitted requests, not an alternative cleanup implementation.
function splitTerms(value) {
  const terms = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "(") depth += 1;
    if (value[i] === ")") depth -= 1;
    if (value[i] === "," && depth === 0) { terms.push(value.slice(start, i)); start = i + 1; }
  }
  terms.push(value.slice(start));
  return terms;
}

function matches(row, expression) {
  const group = expression.match(/^(and|or)\((.*)\)$/);
  if (group) {
    const terms = splitTerms(group[2]);
    return group[1] === "and" ? terms.every((term) => matches(row, term)) : terms.some((term) => matches(row, term));
  }
  const condition = expression.match(/^(\w+)\.(not\.in|in|is|eq|gt)\.(.*)$/);
  assert(condition, `unexpected filter: ${expression}`);
  if (condition[2] === "is") { assert.equal(condition[3], "null"); return row[condition[1]] === null; }
  if (condition[2] === "eq") return String(row[condition[1]]) === condition[3];
  if (condition[2] === "gt") return row[condition[1]] > condition[3];
  assert(condition[3].startsWith("(") && condition[3].endsWith(")"));
  const included = condition[3].slice(1, -1).split(",").includes(row[condition[1]]);
  return condition[2] === "not.in" ? row[condition[1]] != null && !included : included;
}

async function main() {
  await test("checked-in approved-project registry contains only the reviewed E2E project", () => {
    assert.deepEqual(checkedInRegistry, ["aecmlskxvhosslnbebui"]);
    assert(!checkedInRegistry.includes(productionRef));
  });
  await test("primary fixture bootstrap identity permits only the generated Account A form", () => {
    const h = sandbox({ registry: [candidateRef] });
    const { primaryFixtureIdentity } = h.load("scripts/provision-e2e-account.cjs");
    const identity = primaryFixtureIdentity("nschess-e2e-deadbeef@proton.me");
    assert.equal(identity.username, "e2e_a_deadbeef");
    assert.equal(identity.metadata.e2e, true);
    assert.equal(identity.metadata.e2e_role, "account_a");
    assert.throws(() => primaryFixtureIdentity("someone@example.com"), /non-generated primary/);
    assertNoEffects(h);
  });
  await test("primary fixture expected Name Style is a safe authoritative catalog identity", () => {
    const h = sandbox({ registry: [candidateRef] });
    const { expectedPrimaryNameStyle } = h.load("scripts/provision-e2e-account.cjs");
    assert.equal(expectedPrimaryNameStyle({ E2E_EXPECTED_NAME_STYLE: "sky" }).itemId, "name-sky");
    assert.equal(expectedPrimaryNameStyle({}).itemId, "");
    assert.throws(() => expectedPrimaryNameStyle({ E2E_EXPECTED_NAME_STYLE: "sky;drop" }), /safe generated Store Name Style/);
    assertNoEffects(h);
  });
  await test("primary fixture resolution rejects absent, duplicate, and unmarked Auth users", async () => {
    const h = sandbox({ registry: [candidateRef] });
    const { resolveExactUser } = h.load("scripts/provision-e2e-account.cjs");
    const email = "nschess-e2e-deadbeef@proton.me";
    await assert.rejects(resolveExactUser([], email, "primary E2E", { role: "account_a" }), /not found/);
    await assert.rejects(resolveExactUser([{ email }, { email }], email, "primary E2E", { role: "account_a" }), /multiple Auth users/);
    await assert.rejects(resolveExactUser([{ email, user_metadata: {} }], email, "primary E2E", { role: "account_a" }), /not marked/);
    const marked = { id: "11111111-1111-4111-8111-111111111111", email, user_metadata: { e2e: true, e2e_role: "account_a" } };
    assert.equal(await resolveExactUser([marked], email, "primary E2E", { role: "account_a" }), marked);
    assertNoEffects(h);
  });
  const blockedCases = [
    ["production explicit URL", { E2E_SUPABASE_URL: productionUrl }, /production/],
    ["production with staging label", { E2E_SUPABASE_URL: productionUrl, E2E_ENVIRONMENT: "staging" }, /production/],
    ["inherited generic production URL is not a fallback", { SUPABASE_URL: productionUrl, E2E_ENVIRONMENT: "staging" }, /Explicit/],
    ["explicit production overrides no safety check", { E2E_SUPABASE_URL: productionUrl, SUPABASE_URL: candidateUrl }, /production/],
    ["missing explicit URL", {}, /Explicit/],
    ["unregistered project", { E2E_SUPABASE_URL: candidateUrl }, /registry/],
    ["environment approval flags have no authority", { E2E_SUPABASE_URL: candidateUrl, E2E_APPROVED_PROJECT_REF: candidateRef, NSCHESS_ENVIRONMENT_PRECHECKED: "1" }, /registry/]
  ];
  for (const [name, env, message] of blockedCases) {
    await test(name, () => {
      const h = sandbox({ env });
      expectBlocked(() => h.load("scripts/e2e-config.cjs").discoverSupabaseConfig(), message);
      assertNoEffects(h);
    });
  }
  await test("production remains denied even if mistakenly registered", () => {
    const h = sandbox({ env: { E2E_SUPABASE_URL: productionUrl }, registry: [productionRef] });
    expectBlocked(() => h.load("scripts/e2e-config.cjs").discoverSupabaseConfig(), /production/);
    assertNoEffects(h);
  });
  await test("reviewed synthetic project accepted only inside isolated unit registry", () => {
    const h = sandbox({ env: { E2E_SUPABASE_URL: candidateUrl + "/", E2E_SUPABASE_ANON_KEY: "unit-public-key" }, registry: [candidateRef] });
    const config = h.load("scripts/e2e-config.cjs").discoverSupabaseConfig();
    assert.equal(config.url, candidateUrl);
    assert.equal(config.projectRef, candidateRef);
    assert.equal(config.anonKey, "unit-public-key");
    assertNoEffects(h);
  });
  await test("generic public credentials never supply the E2E public key", () => {
    const h = sandbox({ env: { E2E_SUPABASE_URL: candidateUrl, SUPABASE_ANON_KEY: "generic-key" }, registry: [candidateRef] });
    assert.equal(h.load("scripts/e2e-config.cjs").discoverSupabaseConfig().hasAnonKey, false);
  });
  for (const url of [
    `http://${candidateRef}.supabase.co`, `${candidateUrl}:443`, `${candidateUrl}:444`,
    `${candidateUrl}/rest/v1`, `${candidateUrl}/..`, `${candidateUrl}?token=unit`, `${candidateUrl}#fragment`,
    `https://user:unit@${candidateRef}.supabase.co`, `${candidateUrl}.example.com`,
    `https://${candidateRef.toUpperCase()}.supabase.co`, "not-a-url"
  ]) {
    await test(`reject noncanonical project URL: ${url.replace(/user:unit@/, "[userinfo]@")}`, () => {
      const h = sandbox({ env: { E2E_SUPABASE_URL: url }, registry: [candidateRef] });
      expectBlocked(() => h.load("scripts/e2e-config.cjs").discoverSupabaseConfig());
      assertNoEffects(h);
    });
  }
  await test("application env/example/CLI files are never discovery fallbacks", () => {
    const h = sandbox({ files: {
      ".env": `SUPABASE_URL=${productionUrl}`, ".env.example": `SUPABASE_URL=${productionUrl}`,
      ".env.local": `E2E_SUPABASE_URL=${productionUrl}`, "supabase/.temp/project-ref": productionRef
    } });
    expectBlocked(() => h.load("scripts/e2e-config.cjs").discoverSupabaseConfig(), /Explicit/);
    assert.equal(h.effects.reads.length, 0);
    assertNoEffects(h);
  });
  await test("remote app cannot supply another backend", () => {
    const h = sandbox({ env: { E2E_SUPABASE_URL: candidateUrl, E2E_BASE_URL: "https://production-app.example" }, registry: [candidateRef] });
    expectBlocked(() => h.load("scripts/e2e-config.cjs").discoverSupabaseConfig(), /local frontend/);
    assertNoEffects(h);
  });

  const entries = [
    ["scripts/test-environment.cjs", []],
    ["scripts/e2e-runner.cjs", ["matchmaking", "--required"]],
    ["scripts/provision-e2e-account.cjs", []],
    ["scripts/provision-e2e-account.cjs", ["--fixture-only"]],
    ["scripts/provision-e2e-account.cjs", ["--wallet-only"]],
    ["scripts/provision-e2e-account.cjs", ["--environment-check"]],
    ["scripts/store-preflight.cjs", []],
    ["scripts/store-auth-boundary-regression.cjs", []]
  ];
  for (const [file, args] of entries) {
    for (const source of ["explicit-production", "generic-production", "unregistered", "env-file-production"]) {
      await test(`${file} ${args.join(" ")}: ${source} blocked despite both preflight bypass flags`, async () => {
        const env = { E2E_ENVIRONMENT: "staging", NSCHESS_ENVIRONMENT_PRECHECKED: "1", E2E_BASE_URL: "http://127.0.0.1:4173" };
        if (source === "explicit-production") env.E2E_SUPABASE_URL = productionUrl;
        if (source === "generic-production") env.SUPABASE_URL = productionUrl;
        if (source === "unregistered") env.E2E_SUPABASE_URL = candidateUrl;
        const files = source === "env-file-production" ? { ".env.e2e": `E2E_SUPABASE_URL=${productionUrl}\nE2E_ENVIRONMENT=staging\n` } : {};
        const h = sandbox({ env, files });
        h.load(file, { main: true, args: [...args, "--environment-preflighted"] });
        await new Promise(setImmediate);
        assert.equal(h.process.exitCode, 2, h.effects.output.join("\n"));
        assert.match(h.effects.output.join("\n"), /BLOCKED\/ENVIRONMENT/);
        assertNoEffects(h);
      });
    }
  }
  for (const env of [{}, { E2E_SUPABASE_URL: productionUrl, E2E_ENVIRONMENT: "staging" }, { E2E_SUPABASE_URL: candidateUrl }]) {
    await test(`server with ${env.E2E_SUPABASE_URL || "missing URL"} exposes no backend config`, () => {
      const h = sandbox({ env });
      h.load("scripts/e2e-server.cjs", { main: true });
      let status;
      let body;
      h.effects.servers[0]({ url: "/api/auth-config" }, {
        writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); }
      });
      assert.equal(status, 503);
      assert.equal(body.code, "E2E_PROJECT_NOT_APPROVED");
      assert.equal(body.url, undefined);
      assert.equal(body.anonKey, undefined);
      assertNoEffects(h);
    });
  }

  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const outsider = "33333333-3333-4333-8333-333333333333";
  const gameId = "44444444-4444-4444-8444-444444444444";
  await test("cleanup refuses production before any request", async () => {
    const h = sandbox();
    await assert.rejects(h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(productionUrl, "unit-key", a, b), /production/);
    assertNoEffects(h);
  });
  await test("cleanup refuses identical or malformed account IDs", async () => {
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true });
    const cleanup = h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures;
    await assert.rejects(cleanup(candidateUrl, "unit-key", a, a), /distinct exact/);
    await assert.rejects(cleanup(candidateUrl, "unit-key", a, `${b},${outsider}`), /distinct exact/);
    assertNoEffects(h);
  });
  await test("cleanup deletes fixture-only rows and preserves every third-party combination", async () => {
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, fixtureRows: {
      game_challenges: [{ id: gameId, revision: 0, creator_id: a, opponent_id: b }]
    } });
    await h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b);
    const deletes = h.effects.requests.filter((request) => request.method === "DELETE");
    assert.equal(deletes.length, 5);
    const columns = { game_challenges: ["creator_id", "opponent_id"], friend_requests: ["sender_id", "receiver_id"], social_notifications: ["recipient_id", "actor_id"] };
    const seen = [];
    for (const request of deletes) {
      assert.equal(request.method, "DELETE");
      const url = new URL(request.url);
      assert.equal(url.origin, candidateUrl);
      const table = url.pathname.split("/").pop();
      seen.push(table);
      const filters = [...url.searchParams].map(([key, value]) => key === "and" || key === "or" ? `${key}${value}` : `${key}.${value}`);
      const deleted = (row) => filters.every((filter) => matches(row, filter));
      if (!columns[table]) {
        for (const id of [a, b, outsider, null]) assert.equal(deleted({ user_id: id }), id === a || id === b);
        continue;
      }
      const [first, second] = columns[table];
      for (const x of [a, b, outsider, null]) for (const y of [a, b, outsider, null]) {
        const expected = [a, b].includes(x) && ([a, b].includes(y) || (table === "game_challenges" && y === null));
        assert.equal(deleted({ id: gameId, revision: 0, [first]: x, [second]: y }), expected, `${table}: ${x}/${y}`);
      }
    }
    assert.deepEqual(seen.sort(), ["friend_presence", "friend_requests", "game_challenges", "matchmaking_queue", "social_notifications"]);
    assert.equal(h.effects.subprocesses, 0);
    assert.equal(h.effects.writes, 0);
  });

  // Execute the actual browser diagnostic callback in a second VM. All browser
  // network and client calls are mocks; a bad config must reach none of them.
  const otherRef = "tsrqponmlkjihgfedcba";
  const unitEnv = { E2E_SUPABASE_URL: candidateUrl, E2E_SUPABASE_ANON_KEY: "unit-public-key" };
  for (const [name, config, accepted] of [
    ["approved", { url: candidateUrl, anonKey: "unit-public-key" }, true],
    ["production", { url: productionUrl, anonKey: "unit-public-key" }, false],
    ["different approved project", { url: `https://${otherRef}.supabase.co`, anonKey: "unit-public-key" }, false],
    ["unapproved", { url: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co", anonKey: "unit-public-key" }, false],
    ["missing", { anonKey: "unit-public-key" }, false],
    ["wrong public configuration", { url: candidateUrl, anonKey: "wrong-unit-key" }, false]
  ]) {
    await test(`actual browser Store probe: ${name} config ${accepted ? "accepted" : "rejected before client/network"}`, async () => {
      const h = sandbox({ env: unitEnv, registry: [candidateRef, otherRef] });
      const calls = { client: 0, auth: 0, rpc: 0, config: 0, closed: false };
      const browserGlobal = {
        performance, setTimeout, clearTimeout,
        fetch: async (url, options) => {
          assert.equal(url, "/api/auth-config", "unexpected browser network");
          assert.equal(options.redirect, "error", "config redirects must not contact another host");
          calls.config += 1;
          return { ok: true, status: 200, json: async () => config };
        },
        supabase: { createClient(url, key) {
          assert.equal(url, candidateUrl);
          assert.equal(key, "unit-public-key");
          calls.client += 1;
          return { auth: { getUser: async () => { calls.auth += 1; return { data: { user: { id: a } } }; } },
            rpc: async (name) => { assert.equal(name, "get_store_state"); calls.rpc += 1; return { data: {} }; } };
        } }
      };
      browserGlobal.window = browserGlobal;
      const pageContext = vm.createContext(browserGlobal);
      const page = {
        on() {}, goto: async () => {},
        exposeFunction: async (name, fn) => { browserGlobal[name] = fn; },
        evaluate: async (fn) => vm.runInContext(`(${fn.toString()})()`, pageContext, { timeout: 2000 })
      };
      const browser = { newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => { calls.closed = true; } }) };
      const result = await h.load("scripts/e2e-runner.cjs").runControlledStoreRpcProbe(browser, "http://127.0.0.1:4173", {}, "unit probe");
      assert.equal(result.probe?.outcome, accepted ? "rpc_settled" : "probe_error", JSON.stringify(result));
      assert.equal(calls.config, 1, "exactly one local config read");
      assert.equal(calls.client, Number(accepted));
      assert.equal(calls.auth, Number(accepted));
      assert.equal(calls.rpc, Number(accepted));
      assert.equal(calls.closed, true);
      assertNoEffects(h);
    });
  }
  await test("browser probe without approval never opens a browser or sends config/network requests", async () => {
    const h = sandbox();
    let opened = false;
    const result = await h.load("scripts/e2e-runner.cjs").runControlledStoreRpcProbe({ newContext() { opened = true; throw new Error("unexpected browser"); } }, "http://127.0.0.1:4173", {}, "unit");
    assert.equal(result.outcome, "probe_setup_error");
    assert.match(result.error, /BLOCKED\/ENVIRONMENT/);
    assert.equal(opened, false);
    assertNoEffects(h);
  });
  for (const [name, response, accepted] of [
    ["own server and approved config", {}, true],
    ["another server on same port", { config: { e2eServerInstance: "wrong-instance" } }, false],
    ["production config", { config: { url: productionUrl } }, false],
    ["unregistered config", { config: { url: `https://${otherRef}.supabase.co` } }, false],
    ["redirect", { status: 302 }, false],
    ["HTTP 404", { status: 404 }, false],
    ["spawn failure", { spawnError: true }, false]
  ]) {
    await test(`spawned-server readiness: ${name}`, async () => {
      const h = sandbox({ env: unitEnv, registry: [candidateRef], localServer: response });
      const start = h.load("scripts/e2e-local-server.cjs").startE2EServer;
      const result = start({ root, baseUrl: "http://127.0.0.1:4173", stdio: "ignore" });
      if (accepted) assert(await result); else await assert.rejects(result);
      assert.equal(h.effects.subprocesses, 1, "one mocked local server only");
      assert.equal(h.effects.requests.length, 1, "one mocked loopback readiness read only");
      assert.equal(h.effects.serverKilled, !accepted);
      assert.equal(h.effects.writes, 0);
    });
  }
  await test("server startup without approved identity cannot spawn or request readiness", async () => {
    const h = sandbox();
    await assert.rejects(h.load("scripts/e2e-local-server.cjs").startE2EServer({ root, baseUrl: "http://127.0.0.1:4173" }), /BLOCKED\/ENVIRONMENT/);
    assertNoEffects(h);
  });
  for (const [name, env, staticFiles, accepted] of [
    ["static-only with no project", {}, ["docs/README.md"], true],
    ["static-only with inherited production and purchase setting", { SUPABASE_URL: productionUrl, E2E_PURCHASE_ITEM_ID: "unit-item" }, ["docs/README.md"], true],
    ["live affected with no project and both bypass flags", { NSCHESS_ENVIRONMENT_PRECHECKED: "1" }, ["assets/app.js"], false],
    ["live affected with production and both bypass flags", { E2E_SUPABASE_URL: productionUrl, E2E_ENVIRONMENT: "staging", NSCHESS_ENVIRONMENT_PRECHECKED: "1" }, ["assets/app.js"], false]
  ]) {
    await test(`actual affected entry: ${name}`, async () => {
      const h = sandbox({ env, staticFiles });
      h.load("scripts/e2e-runner.cjs", { main: true, args: ["affected", "--environment-preflighted"] });
      await new Promise(setImmediate);
      assert.equal(h.process.exitCode, accepted ? 0 : 2, h.effects.output.join("\n"));
      if (accepted) {
        assert.match(h.effects.output.join("\n"), /changed files do not touch/);
        assert(h.effects.staticChecks.includes("scripts/e2e-safety-regression.cjs"));
        assert(h.effects.staticChecks.includes("scripts/verify-site.js"));
      } else {
        assert.equal(h.effects.staticChecks.length, 0);
        assert.match(h.effects.output.join("\n"), /BLOCKED\/ENVIRONMENT/);
      }
      assertNoEffects(h);
    });
  }
  for (const [table, owner] of [["game_challenge_messages", "user_id"], ["game_challenge_presence", "user_id"], ["game_challenge_validation_events", "actor_id"]]) {
    for (const user of [outsider, null]) {
      await test(`cleanup refuses parent with ${table} ${user === null ? "unattributed" : "third-party"} child`, async () => {
        const rows = { game_challenges: [{ id: gameId, revision: 0, creator_id: a, opponent_id: b }], [table]: [{ challenge_id: gameId, [owner]: user }] };
        const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, fixtureRows: rows });
        await assert.rejects(h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b), /fixture contamination/);
        assert.equal(h.effects.requests.filter((request) => request.method === "DELETE").length, 0);
        assert.deepEqual(h.database, rows, "cascade child/parent was altered");
      });
    }
  }
  await test("cleanup refuses tournament SET NULL side effects even for an A/B pairing", async () => {
    const rows = { game_challenges: [{ id: gameId, revision: 0, creator_id: a, opponent_id: b }], tournament_pairings: [{ challenge_id: gameId, white_id: a, black_id: b }] };
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, fixtureRows: rows });
    await assert.rejects(h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b), /tournament linkage/);
    assert.equal(h.effects.requests.filter((request) => request.method === "DELETE").length, 0);
    assert.deepEqual(h.database, rows);
  });
  await test("failed child inspection stops cleanup rather than assuming no children", async () => {
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, fixtureRows: {
      game_challenges: [{ id: gameId, revision: 0, creator_id: a, opponent_id: b }]
    }, fixtureReadFailure: "game_challenge_presence" });
    await assert.rejects(h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b), /inspection denied/);
    assert.equal(h.effects.requests.filter((request) => request.method === "DELETE").length, 0);
  });
  await test("legitimate A/B child cascades work while other parents and their children survive", async () => {
    const otherGame = "55555555-5555-4555-8555-555555555555";
    const rows = { game_challenges: [{ id: gameId, revision: 2, creator_id: a, opponent_id: b }, { id: otherGame, revision: 0, creator_id: a, opponent_id: outsider }] };
    for (const [table, owner] of [["game_challenge_messages", "user_id"], ["game_challenge_presence", "user_id"], ["game_challenge_validation_events", "actor_id"]]) {
      rows[table] = [{ challenge_id: gameId, [owner]: a }, { challenge_id: gameId, [owner]: b }, { challenge_id: otherGame, [owner]: outsider }];
    }
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, fixtureRows: rows });
    await h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b);
    assert.deepEqual(h.database.game_challenges, [rows.game_challenges[1]]);
    for (const table of ["game_challenge_messages", "game_challenge_presence", "game_challenge_validation_events"]) assert.deepEqual(h.database[table], [rows[table][2]]);
    const parentDelete = h.effects.requests.find((r) => r.method === "DELETE" && new URL(r.url).pathname.endsWith("/game_challenges"));
    assert.equal(new URL(parentDelete.url).searchParams.get("id"), `eq.${gameId}`);
    assert.equal(new URL(parentDelete.url).searchParams.get("revision"), "eq.2");
  });
  await test("cleanup audits every parent page before deletion, even with server-side row caps", async () => {
    const nextGame = "55555555-5555-4555-8555-555555555555";
    const h = sandbox({ registry: [candidateRef], recordFixtureDeletes: true, pageSize: 1, fixtureRows: {
      game_challenges: [{ id: gameId, revision: 0, creator_id: a, opponent_id: b }, { id: nextGame, revision: 0, creator_id: b, opponent_id: a }],
      game_challenge_messages: [{ challenge_id: nextGame, user_id: outsider }]
    } });
    await assert.rejects(h.load("scripts/provision-e2e-account.cjs").resetSocialFixtures(candidateUrl, "unit-key", a, b), /fixture contamination/);
    assert.equal(h.effects.requests.filter((request) => request.method === "DELETE").length, 0);
    assert.equal(h.database.game_challenges.length, 2);
  });
  await test("normal CI verification runs the standalone offline safety command without live prerequisites", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(pkg.scripts["test:e2e-safety"], "node scripts/e2e-safety-regression.cjs");
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/verify.yml"), "utf8").split("  stability-gate:")[0];
    assert.match(workflow, /run: npm run test:e2e-safety/);
    assert.match(workflow, /run: node scripts\/verify-site\.js/);
    assert.doesNotMatch(workflow, /secrets\.|test:environment|test:matchmaking-live|provision-e2e-account/);
  });
  console.log(`PASS offline E2E safety: ${passed} checks; no live network, browser, provisioning, SQL, or file writes`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
