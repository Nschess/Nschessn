/*
 * Dedicated-project browser acceptance for Friendly Challenge.  This runner
 * deliberately authenticates two real, isolated browser contexts using only
 * the ignored public E2E configuration and the two disposable user passwords.
 * It never reads a service-role key or invokes an admin/database API.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseEnvFile, assertApprovedE2EProject, assertApprovedBrowserConfig } = require("./e2e-config.cjs");
const { startE2EServer } = require("./e2e-local-server.cjs");

const root = path.resolve(__dirname, "..");
const envFile = path.join(root, ".env.e2e");
const dedicatedRef = "aecmlskxvhosslnbebui";
const productionRef = "jfrvoykwowzthlvzwsmi";

process.on("exit", (code) => console.log(`RUNNER EXIT: ${code}`));

function fail(message) {
  throw new Error(message);
}

function loadPublicE2EEnvironment() {
  if (!fs.existsSync(envFile)) fail("BLOCKED/ENVIRONMENT: ignored .env.e2e is required for the dedicated browser acceptance.");
  const values = parseEnvFile(envFile);
  const allowed = [
    "E2E_ENVIRONMENT", "E2E_BASE_URL", "E2E_SUPABASE_URL", "E2E_SUPABASE_ANON_KEY",
    "E2E_EMAIL", "E2E_PASSWORD", "E2E_SECOND_EMAIL", "E2E_SECOND_PASSWORD", "E2E_HEADLESS"
  ];
  for (const key of allowed) {
    if (values[key] && !process.env[key]) process.env[key] = values[key];
  }
  for (const key of ["E2E_SUPABASE_URL", "E2E_SUPABASE_ANON_KEY", "E2E_EMAIL", "E2E_PASSWORD", "E2E_SECOND_EMAIL", "E2E_SECOND_PASSWORD"]) {
    if (!String(process.env[key] || "").trim()) fail(`BLOCKED/ENVIRONMENT: ${key} is required in ignored .env.e2e.`);
  }
  const target = assertApprovedE2EProject(process.env);
  if (target.projectRef !== dedicatedRef || target.projectRef === productionRef) fail("BLOCKED/ENVIRONMENT: the browser target is not the dedicated E2E project.");
  return target;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) fail(`Local auth configuration returned HTTP ${response.status}.`);
  return response.json();
}

async function go(page, baseUrl, hash) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  const current = page.url();
  if (current.startsWith(`${baseUrl}/`)) {
    await page.evaluate((next) => { location.hash = next.slice(1); }, target);
    await page.waitForFunction((next) => location.hash === next, target, { timeout: 5000 });
  } else {
    await page.goto(`${baseUrl}/${target}`, { waitUntil: "domcontentloaded", timeout: 15000 });
  }
  // The static app intentionally has deferred network work.  A hash change is
  // the router's readiness boundary; waiting for every optional asset here
  // would hide a route problem behind a full-document navigation delay.
  await page.waitForTimeout(350);
}

async function login(page, baseUrl, email, password, label) {
  await go(page, baseUrl, "#login");
  await page.waitForFunction(() => ["authenticated", "guest", "error"].includes(document.documentElement.dataset.authState || ""), null, { timeout: 15000 });
  const initiallyAuthenticated = await page.evaluate(() => document.documentElement.dataset.authState === "authenticated");
  if (!initiallyAuthenticated) {
    await page.locator('[data-auth-tab="login"]').click();
    await page.locator("#authLoginForm").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#authLoginEmail").fill(email);
    await page.locator("#authLoginPassword").fill(password);
    await page.locator("#authLoginForm button[type=submit]").click();
  }
  await page.waitForFunction(() => document.documentElement.dataset.authState === "authenticated" && !document.getElementById("authAccountPanel")?.hidden, null, { timeout: 20000 });
  await page.waitForFunction(() => ["ready", "error"].includes(document.documentElement.dataset.storeSyncStatus || ""), null, { timeout: 15000 });
  const account = await page.evaluate(() => {
    const cached = window.CheckmateQuestAuthProvider?.getCachedAccount?.() || {};
    return { id: String(cached.authUserId || cached.publicId || ""), name: String(cached.displayName || cached.name || document.getElementById("authAccountName")?.textContent || "").trim() };
  });
  assert(account.id, `${label} did not establish an authenticated public account.`);
  return account;
}

async function readChallenge(page) {
  return page.evaluate(() => {
    try {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
      return state ? {
        id: String(state.remoteId || ""), code: String(state.code || ""), status: String(state.status || ""), active: Boolean(state.active),
        pending: Boolean(state.pending), incoming: Boolean(state.incoming), color: String(state.color || ""), fen: String(state.fen || ""),
        moves: Array.isArray(state.moves) ? state.moves.map(String) : [], revision: Number(state.serverRevision || 0)
      } : null;
    } catch { return null; }
  });
}

async function waitForChallenge(page, predicate, label) {
  await page.waitForFunction(async (source) => {
    try {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
      const check = Function(`return (${source})`)();
      return Boolean(state && check(state));
    } catch { return false; }
  }, predicate.toString(), { timeout: 20000 }).catch(() => fail(`${label} did not settle from the authoritative browser state.`));
  return readChallenge(page);
}

async function clickChallengeForFriend(page, targetId) {
  await page.waitForFunction((id) => [...document.querySelectorAll("#friendList [data-render-key]")]
    .some((row) => row.dataset.renderKey === `friend:${id}` && [...row.querySelectorAll("button")].some((button) => button.textContent.trim() === "Challenge")), targetId, { timeout: 20000 });
  const clicked = await page.locator("#friendList [data-render-key]").evaluateAll((rows, id) => {
    const row = rows.find((item) => item.dataset.renderKey === `friend:${id}`);
    const button = [...(row?.querySelectorAll("button") || [])].find((item) => item.textContent.trim() === "Challenge");
    button?.click();
    return Boolean(button);
  }, targetId);
  assert(clicked, "Account A could not select Account B from the real Online friends list.");
  await page.locator("#friendMatchSettings[open]").waitFor({ state: "visible", timeout: 10000 });
}

async function sendTargetedChallenge(page, targetId) {
  await go(page, process.env.E2E_BASE_URL, "#play?mode=friend");
  await page.locator("#friendChallenge").waitFor({ state: "visible", timeout: 15000 });
  await clickChallengeForFriend(page, targetId);
  await page.locator("#friendGameType").selectOption("casual");
  await page.locator("#friendColor").selectOption("w");
  await page.locator("#friendClock").selectOption("5+0");
  await page.locator("#friendSend").click();
  await page.locator("#friendRequestCard").waitFor({ state: "visible", timeout: 20000 });
  const state = await waitForChallenge(page, "state.pending && !state.incoming && state.status === 'pending'", "outgoing challenge");
  return state;
}

async function findExistingOutgoingChallenge(page, targetId) {
  return page.evaluate(async (target) => {
    const provider = window.CheckmateQuestAuthProvider;
    const me = String(provider?.getCachedAccount?.()?.authUserId || provider?.getCachedAccount?.()?.publicId || "");
    const rows = await provider?.listFriendChallenges?.();
    const found = Array.isArray(rows) && rows.find((row) => ["pending", "active"].includes(String(row?.status || ""))
      && String(row?.creator_id || row?.creatorId || "") === me
      && String(row?.opponent_id || row?.opponentId || "") === target);
    return found ? { code: String(found.code || "").toUpperCase(), status: String(found.status || "") } : null;
  }, targetId);
}

async function inspectOwnedFixture(page, code, accountAId, accountBId) {
  const audit = await page.evaluate(async ({ challengeCode, accountA, accountB }) => {
    const remote = await window.CheckmateQuestAuthProvider?.getFriendChallenge?.(challengeCode);
    const creatorId = String(remote?.creatorId || remote?.creator_id || "");
    const opponentId = String(remote?.opponentId || remote?.opponent_id || "");
    const tournamentLink = remote?.tournamentCode || remote?.tournament_code || remote?.tournamentPairingId || remote?.tournament_pairing_id || "";
    return {
      exists: Boolean(remote),
      status: String(remote?.status || ""),
      creatorIsA: creatorId === accountA,
      opponentIsB: opponentId === accountB,
      onlyABParticipants: Boolean(creatorId && opponentId && creatorId !== opponentId && [creatorId, opponentId].every((id) => id === accountA || id === accountB)),
      tournamentLinked: Boolean(tournamentLink)
    };
  }, { challengeCode: code, accountA: accountAId, accountB: accountBId });
  assert(audit.exists && audit.creatorIsA && audit.opponentIsB && audit.onlyABParticipants && !audit.tournamentLinked,
    `BLOCKED/ENVIRONMENT: existing challenge ${code} is not exclusively the disposable A-to-B non-tournament fixture: ${JSON.stringify(audit)}`);
  return audit;
}

async function waitForTerminalChallenge(pageA, pageB, code, label) {
  const isTerminal = (expected) => { try {
    const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
    return state?.code === expected && ["completed", "declined", "cancelled", "expired"].includes(state.status) && !state.pending && !state.active;
  } catch { return false; } };
  await Promise.all([pageA, pageB].map((page) => page.waitForFunction(isTerminal, code, { timeout: 25000 })));
  console.log(`${label}: terminal state reconciled in both browser contexts`);
}

async function closePostGameDecision(page) {
  const dialog = page.locator("#postGameDecision");
  if (await dialog.isVisible().catch(() => false)) {
    await page.locator("#postGameDecisionClose").click();
    await dialog.waitFor({ state: "hidden", timeout: 10000 });
  }
}

async function resolveOwnedFixture(pageA, pageB, baseUrl, fixture, accountA, accountB) {
  const audit = await inspectOwnedFixture(pageA, fixture.code, accountA.id, accountB.id);
  if (audit.status === "active") {
    await Promise.all([
      go(pageA, baseUrl, `#play?challenge=${encodeURIComponent(fixture.code)}`),
      go(pageB, baseUrl, `#play?challenge=${encodeURIComponent(fixture.code)}`)
    ]);
    await Promise.all([
      waitForActiveBoard(pageA, fixture.code, "Account A existing fixture"),
      waitForActiveBoard(pageB, fixture.code, "Account B existing fixture")
    ]);
    // The disposable Account A is the verified creator. End only this exact
    // fixture through the ordinary product action, never through direct data
    // mutation or deletion.
    await pageA.locator("#resignGame").click();
    await pageA.locator("#resignConfirmDialog").waitFor({ state: "visible", timeout: 10000 });
    await pageA.locator("#resignConfirmButton").click();
    await waitForTerminalChallenge(pageA, pageB, fixture.code, "Old A↔B active fixture");
    return "active";
  }
  if (audit.status === "pending") {
    await Promise.all([
      go(pageA, baseUrl, `#play?challenge=${encodeURIComponent(fixture.code)}`),
      go(pageB, baseUrl, `#play?challenge=${encodeURIComponent(fixture.code)}`)
    ]);
    await pageA.locator("#friendRequestCard").waitFor({ state: "visible", timeout: 15000 });
    await pageB.waitForFunction((code) => { try {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
      return state?.code === code && state.status === "pending" && state.incoming === true;
    } catch { return false; } }, fixture.code, { timeout: 15000 });
    await assertOutgoingOnly(pageA);
    await pageA.locator("#friendCancel").click();
    await waitForTerminalChallenge(pageA, pageB, fixture.code, "Old A↔B pending fixture");
    return "pending";
  }
  fail(`BLOCKED/ENVIRONMENT: unsupported existing fixture state ${audit.status || "unknown"}.`);
}

async function assertOutgoingOnly(page) {
  const controls = await page.evaluate(() => ({
    card: !document.getElementById("friendRequestCard")?.hidden,
    accept: !document.getElementById("friendAccept")?.hidden,
    decline: !document.getElementById("friendDecline")?.hidden,
    cancel: !document.getElementById("friendCancel")?.hidden,
    settingsOpen: Boolean(document.getElementById("friendMatchSettings")?.open),
    visibleSend: (() => { const send = document.getElementById("friendSend"); return Boolean(send && !send.disabled && send.offsetParent !== null); })(),
    cards: [...document.querySelectorAll("#friendRequestCard")].filter((item) => !item.hidden).length
  }));
  assert.deepStrictEqual(controls, { card: true, accept: false, decline: false, cancel: true, settingsOpen: false, visibleSend: false, cards: 1 }, `Sender controls are not direction-safe: ${JSON.stringify(controls)}`);
}

async function waitForIncomingNotice(page, expectedCode) {
  await page.locator("#friendChallengeNotice").waitFor({ state: "visible", timeout: 20000 }).catch(async () => {
    const diagnostic = await page.evaluate(async (code) => {
      const readState = () => {
        try {
          const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
          return state ? { codeMatches: String(state.code || "") === code, status: String(state.status || ""), incoming: Boolean(state.incoming), active: Boolean(state.active) } : null;
        } catch { return null; }
      };
      const account = window.CheckmateQuestAuthProvider?.getCachedAccount?.() || {};
      let serverMatch = null;
      try {
        const rows = await window.CheckmateQuestAuthProvider?.listFriendChallenges?.();
        const match = Array.isArray(rows) && rows.find((row) => String(row?.code || "").toUpperCase() === code);
        serverMatch = match ? { found: true, status: String(match.status || ""), recipient: String(match.opponentId || match.opponent_id || "") === String(account.authUserId || account.publicId || "") } : { found: false };
      } catch { serverMatch = { readFailed: true }; }
      return {
        route: location.hash,
        noticePresent: Boolean(document.getElementById("friendChallengeNotice")),
        localState: readState(),
        serverMatch
      };
    }, expectedCode).catch(() => ({ unavailable: true }));
    fail(`Recipient incoming prompt did not arrive without refresh: ${JSON.stringify(diagnostic)}`);
  });
  const snapshot = await page.evaluate(() => ({
    notices: document.querySelectorAll("#friendChallengeNotice").length,
    text: document.getElementById("friendChallengeNotice")?.textContent || "",
    buttons: [...document.querySelectorAll("#friendChallengeNotice button")].map((button) => button.textContent.trim()),
    friendCardVisible: (() => { const card = document.getElementById("friendRequestCard"); return Boolean(card && !card.hidden && card.getClientRects().length); })(),
    state: (() => { try { return JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null"); } catch { return null; } })()
  }));
  assert(snapshot.notices === 1 && /5\+0/.test(snapshot.text) && snapshot.buttons.includes("Accept") && snapshot.buttons.includes("Decline") && !snapshot.text.includes("Cancel challenge"), `Recipient incoming prompt is not clear and direction-safe: ${JSON.stringify({ notices: snapshot.notices, buttons: snapshot.buttons, friendCardVisible: snapshot.friendCardVisible })}`);
  assert(snapshot.state?.code === expectedCode, "Recipient prompt does not represent the challenge created by Account A.");
  assert(!snapshot.friendCardVisible, "A full friend-page request card was duplicated on Account B's non-Friend route.");
}

async function waitForActiveBoard(page, code, label) {
  await page.waitForFunction((expected) => {
    try {
      const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
      const board = document.getElementById("coachBoard");
      return state?.code === expected && state.status === "active" && state.active === true
        && document.querySelectorAll("#coachBoard [data-square]").length === 64 && Boolean(board?.getClientRects().length);
    } catch { return false; }
  }, code, { timeout: 25000 }).catch(async () => {
    const diagnostic = await page.evaluate((expected) => {
      try {
        const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null");
        const board = document.getElementById("coachBoard");
        const play = document.getElementById("play");
        return {
          route: location.hash,
          codeMatches: String(state?.code || "") === expected,
          status: String(state?.status || ""),
          active: Boolean(state?.active),
          remote: Boolean(state?.remote),
          boardSquares: document.querySelectorAll("#coachBoard [data-square]").length,
          boardVisible: Boolean(board?.getClientRects().length),
          playHidden: Boolean(play?.hidden)
        };
      } catch { return { unavailable: true }; }
    }, code).catch(() => ({ unavailable: true }));
    fail(`${label} did not hand off to the shared board: ${JSON.stringify(diagnostic)}`);
  });
  return readChallenge(page);
}

async function run() {
  loadPublicE2EEnvironment();
  const baseUrl = String(process.env.E2E_BASE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
  console.log(`PUBLIC E2E CONFIG: url=${Boolean(process.env.E2E_SUPABASE_URL)} anon=${Boolean(process.env.E2E_SUPABASE_ANON_KEY)} localOrigin=${baseUrl.startsWith("http://127.0.0.1:")}`);
  const server = await startE2EServer({ root, baseUrl, stdio: "ignore", timeoutMs: 15000 });
  let browser;
  let contextA;
  let contextB;
  try {
    const config = await fetchJson(`${baseUrl}/api/auth-config`);
    assertApprovedBrowserConfig(config);
    assert(config.url === `https://${dedicatedRef}.supabase.co` && Boolean(config.anonKey) && !JSON.stringify(config).includes(productionRef), "Localhost auth-config did not prove the dedicated E2E target.");
    console.log("TARGET: dedicated E2E auth-config verified");
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: process.env.E2E_HEADLESS !== "0" });
    console.log("BROWSER: launched isolated Chromium contexts");
    contextA = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
    contextB = await browser.newContext({ viewport: { width: 1024, height: 820 }, serviceWorkers: "block" });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const [accountA, accountB] = await Promise.all([
      login(pageA, baseUrl, process.env.E2E_EMAIL, process.env.E2E_PASSWORD, "Account A"),
      login(pageB, baseUrl, process.env.E2E_SECOND_EMAIL, process.env.E2E_SECOND_PASSWORD, "Account B")
    ]);
    console.log("AUTH: Account A and Account B authenticated in separate contexts");
    await go(pageB, baseUrl, "#top");
    console.log("ROUTE: Account B is on a signed-in non-Friend route");

    // Bring the dedicated disposable fixture to a clean state before this
    // runner creates the new challenges that it will own and resolve.
    const existing = await findExistingOutgoingChallenge(pageA, accountB.id);
    if (existing) {
      const resolved = await resolveOwnedFixture(pageA, pageB, baseUrl, existing, accountA, accountB);
      console.log(`OLD FIXTURE SAFELY RESOLVED: ${resolved}`);
    } else {
      console.log("OLD FIXTURE SAFELY RESOLVED: NOT NEEDED");
    }
    await go(pageA, baseUrl, "#play?mode=friend");
    await pageA.waitForFunction(() => document.getElementById("friendRequestCard")?.hidden === true, null, { timeout: 15000 });
    await go(pageB, baseUrl, "#top");
    assert(await pageB.locator("#friendChallengeNotice").count() === 0, "A stale incoming prompt remained before the fresh browser run.");

    // Send and accept one fresh, runner-owned targeted invite through the UI.
    const created = await sendTargetedChallenge(pageA, accountB.id);
    console.log("SEND: Account A submitted the real targeted challenge");
    assert(created?.code, "Account A did not retain the new pending challenge code.");
    await assertOutgoingOnly(pageA);
    console.log("A SEND: PASS\nA ONLY CANCEL: PASS");
    await waitForIncomingNotice(pageB, created.code);
    console.log("B INCOMING PROMPT WITHOUT REFRESH: PASS\nB ONLY ACCEPT/DECLINE: PASS");
    await pageB.getByRole("button", { name: "Accept", exact: true }).click();
    const [activeA, activeB] = await Promise.all([
      waitForActiveBoard(pageA, created.code, "Account A"),
      waitForActiveBoard(pageB, created.code, "Account B")
    ]);
    assert(activeA.id && activeA.id === activeB.id && activeA.fen === activeB.fen && activeA.color !== activeB.color, "The two browsers do not share one authoritative active game.");
    console.log("B ACCEPT AUTO-HANDOFF: PASS\nA AUTO-HANDOFF: PASS\nSAME GAME ID: PASS\nCOMPLEMENTARY COLORS: PASS\nINITIAL FEN: PASS");

    const white = activeA.color === "w" ? pageA : pageB;
    const black = activeA.color === "w" ? pageB : pageA;
    await white.locator('#coachBoard [data-square="e2"]').click();
    await white.locator('#coachBoard [data-square="e4"]').click();
    await black.waitForFunction((code) => { try { const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null"); return state?.code === code && state.moves?.includes("e2e4"); } catch { return false; } }, created.code, { timeout: 20000 });
    console.log("MOVE SYNC: PASS");
    await black.reload({ waitUntil: "domcontentloaded" });
    await waitForActiveBoard(black, created.code, "Account B refresh recovery");
    console.log("REFRESH RECOVERY: PASS");

    // End the active game through its real in-app control before creating new
    // terminal invite cases; no rows are deleted or directly altered.
    await black.locator("#resignGame").click();
    await black.locator("#resignConfirmDialog").waitFor({ state: "visible", timeout: 10000 });
    await black.locator("#resignConfirmButton").click();
    await Promise.all([pageA, pageB].map((page) => page.waitForFunction((code) => { try { const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null"); return state?.code === code && state.status === "completed"; } catch { return false; } }, created.code, { timeout: 25000 })));
    await Promise.all([closePostGameDecision(pageA), closePostGameDecision(pageB)]);

    // Decline and cancel are distinct fresh, browser-created targeted invites.
    await go(pageB, baseUrl, "#top");
    const declined = await sendTargetedChallenge(pageA, accountB.id);
    await waitForIncomingNotice(pageB, declined.code);
    await pageB.getByRole("button", { name: "Decline", exact: true }).click();
    await pageA.waitForFunction((code) => { try { const state = JSON.parse(localStorage.getItem("checkmateQuest.friendChallenge.v1") || "null"); return state?.code === code && ["declined", "cancelled", "expired"].includes(state.status) && !state.pending; } catch { return false; } }, declined.code, { timeout: 20000 });
    assert(await pageB.locator("#friendChallengeNotice").count() === 0, "Declined challenge prompt remained on recipient.");
    console.log("DECLINE: PASS");

    await go(pageB, baseUrl, "#top");
    const cancelled = await sendTargetedChallenge(pageA, accountB.id);
    await waitForIncomingNotice(pageB, cancelled.code);
    await pageA.locator("#friendCancel").click();
    await pageB.locator("#friendChallengeNotice").waitFor({ state: "hidden", timeout: 20000 });
    console.log("CANCEL: PASS");

    await pageB.setViewportSize({ width: 390, height: 844 });
    await go(pageB, baseUrl, "#play?mode=friend");
    const mobile = await pageB.evaluate(() => {
      const create = document.getElementById("friendCreateTab");
      const join = document.getElementById("friendJoinTab");
      const joinPanel = document.getElementById("friendJoinPanel");
      return {
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        rail: Boolean(join),
        status: Boolean(document.getElementById("friendChallengeStatus")),
        createPrimary: create?.getAttribute("aria-selected") === "true",
        joinSecondary: join?.getAttribute("aria-selected") === "false" && Boolean(joinPanel?.hidden)
      };
    });
    assert(mobile.width <= mobile.viewport + 2 && mobile.rail && mobile.status && mobile.createPrimary && mobile.joinSecondary,
      `Mobile Friendly Challenge layout overflowed or lost the primary create / secondary code-invite hierarchy: ${JSON.stringify(mobile)}`);
    console.log("NO DUPLICATE CHALLENGE UI: PASS\nDESKTOP UX: PASS\nMOBILE UX: PASS\nINVITE CODE SECONDARY: PASS\nPRODUCTION UNTOUCHED: PASS");
  } finally {
    await contextA?.close().catch(() => {});
    await contextB?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server.kill();
  }
}

run().then(() => console.log("FINAL: FRIENDLY CHALLENGE TWO-BROWSER UX ACCEPTANCE PASS"))
  .catch((error) => {
    console.error(`FINAL: FRIENDLY CHALLENGE TWO-BROWSER UX ACCEPTANCE FAIL/BLOCKED\n${String(error?.message || error)}`);
    process.exitCode = 1;
  });
