/*
 * Nschess browser verification harness.
 *
 * The harness deliberately uses dedicated accounts from .env.e2e only. It
 * never stores credentials in the repository and saves Playwright storage
 * state under the ignored .playwright/ directory.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { discoverSupabaseConfig } = require("./e2e-config.cjs");

const root = path.resolve(__dirname, "..");
const envFile = process.env.E2E_ENV_FILE || path.join(root, ".env.e2e");
const artifactDir = path.join(root, "e2e-artifacts");
const snapshotDir = path.join(root, "tests", "e2e", "snapshots");
const mode = process.argv[2] || "affected";
const visualOnly = mode === "visual";

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
const required = process.argv.includes("--required") || process.env.E2E_REQUIRED === "1";

const results = { passed: [], skipped: [], failed: [] };
function pass(name) { results.passed.push(name); console.log(`PASS  ${name}`); }
function skip(name, reason) { results.skipped.push(`${name} — ${reason}`); console.log(`SKIP  ${name} — ${reason}`); }
function fail(name, error) { results.failed.push(`${name} — ${error.message || error}`); console.error(`FAIL  ${name}\n      ${error.stack || error}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function stabilizeVisualContext(context) {
  // Lucide is a progressive enhancement loaded from a third-party CDN. Its
  // load timing previously made the same navbar render as either fallback
  // glyphs or SVG icons between viewport captures. Visual tests intentionally
  // exercise the deterministic, first-party fallback markup.
  await context.route("https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  // Keep browser-level font cache state from changing glyph metrics between
  // the authenticated setup context and the guest visual context.
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await context.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.alloc(0) }));
}

async function canonicalizeVisualIcons(page) {
  await page.evaluate(() => {
    const fallback = {
      swords: "♞",
      bot: "♟",
      puzzle: "◇",
      "graduation-cap": "⌁",
      "play-square": "▶",
      users: "◉",
      trophy: "♛",
      "bar-chart-3": "↑",
      "shopping-bag": "✦",
      search: "Search",
      coins: "◈",
      bell: "◉",
      menu: "Menu",
      "circle-user-round": "●"
    };
    const classNames = {
      "nav-icon": ["swords", "bot", "puzzle", "graduation-cap", "play-square", "users", "trophy", "bar-chart-3", "shopping-bag", "users"],
      "nav-utility-icon": ["search", "coins", "bell"],
      "nav-mobile-icon": ["menu", "swords", "bot", "puzzle", "graduation-cap", "play-square", "trophy", "bar-chart-3", "shopping-bag"]
    };
    const classIndexes = new Map();
    document.querySelectorAll("svg[data-lucide], .site-header svg.nav-icon, .site-header svg.nav-utility-icon, .site-header svg.nav-mobile-icon").forEach((svg) => {
      const className = Object.keys(classNames).find((value) => svg.classList.contains(value)) || "";
      const index = classIndexes.get(className) || 0;
      classIndexes.set(className, index + 1);
      const name = svg.getAttribute("data-lucide") || classNames[className]?.[index] || "";
      const replacement = document.createElement("span");
      for (const attribute of ["class", "data-lucide", "aria-hidden", "title"]) {
        const value = svg.getAttribute(attribute);
        if (value !== null) replacement.setAttribute(attribute, value);
      }
      replacement.textContent = Object.prototype.hasOwnProperty.call(fallback, name) ? fallback[name] : "•";
      svg.replaceWith(replacement);
    });
  });
}

function decodePngRgba(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || !idat.length) return null;
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const inflated = require("zlib").inflateSync(Buffer.concat(idat));
  if (inflated.length < height * (rowBytes + 1)) return null;
  const pixels = Buffer.alloc(height * rowBytes);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source++];
    const rowStart = y * rowBytes;
    const previousStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[source++];
      const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[previousStart + x - bytesPerPixel] : 0;
      pixels[rowStart + x] = filter === 0 ? raw
        : filter === 1 ? (raw + left) & 255
          : filter === 2 ? (raw + above) & 255
            : filter === 3 ? (raw + Math.floor((left + above) / 2)) & 255
              : (raw + paeth(left, above, upperLeft)) & 255;
    }
  }
  return { width, height, bytesPerPixel, pixels };
}

function compareScreenshotBytes(expected, actual) {
  if (crypto.createHash("sha256").update(actual).digest("hex") === crypto.createHash("sha256").update(expected).digest("hex")) {
    return { matches: true, exact: true, maxDelta: 0, differingPixels: 0 };
  }
  const left = decodePngRgba(expected);
  const right = decodePngRgba(actual);
  if (!left || !right || left.width !== right.width || left.height !== right.height || left.bytesPerPixel !== right.bytesPerPixel) {
    return { matches: false, exact: false, reason: "PNG dimensions or format differ" };
  }
  let maxDelta = 0;
  let differingPixels = 0;
  const channels = left.bytesPerPixel;
  for (let i = 0; i < left.pixels.length; i += channels) {
    let pixelDifferent = false;
    for (let channel = 0; channel < channels; channel += 1) {
      const delta = Math.abs(left.pixels[i + channel] - right.pixels[i + channel]);
      maxDelta = Math.max(maxDelta, delta);
      if (delta > 1) pixelDifferent = true;
    }
    if (pixelDifferent) differingPixels += 1;
  }
  const totalPixels = left.width * left.height;
  return {
    // Chromium can quantize a handful of edge pixels differently when the
    // authenticated setup context has just closed. Treat only tiny, local
    // raster noise as equivalent; real layout/icon changes still exceed this.
    matches: maxDelta <= 1 || (maxDelta <= 3 && differingPixels <= 8),
    exact: false,
    maxDelta,
    differingPixels,
    totalPixels,
    reason: `max channel delta ${maxDelta}; ${differingPixels}/${totalPixels} pixels differ by more than one step`
  };
}

function authEnvironmentSummary(email, password, baseUrl) {
  const emailValue = String(email || "").trim();
  const passwordValue = String(password || "");
  const supabase = discoverSupabaseConfig();
  return {
    envFile,
    envFileExists: fs.existsSync(envFile),
    baseMode: /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(baseUrl || "").replace(/\/$/, "")) ? "local" : "remote",
    emailPresent: Boolean(emailValue),
    emailLooksPlaceholder: /^(?:e2e-primary|e2e-secondary)@example\.com$/i.test(emailValue),
    passwordPresent: Boolean(passwordValue),
    passwordLooksPlaceholder: /replace-with|dedicated-test-password/i.test(passwordValue),
    emailLength: emailValue.length,
    passwordLength: passwordValue.length,
    supabaseUrlPresent: supabase.hasUrl,
    supabaseAnonKeyPresent: supabase.hasAnonKey,
    supabaseUrlSource: supabase.urlSource,
    supabaseAnonKeySource: supabase.keySource
  };
}

function redactTraceUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value || "").replace(/[?&](?:token|access_token|apikey|key)=[^&]*/gi, "$1=[redacted]");
  }
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|access_token|apikey|api_key|key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, "[jwt-redacted]")
    .slice(0, 240);
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

function changedFiles() {
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const tracked = (diff.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const untracked = (status.stdout || "").split(/\r?\n/).map((value) => value.slice(3).trim()).filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

function runStaticChecks(full) {
  const checks = [
    ["JavaScript syntax", () => runNode("--check", ["assets/app.js"])],
    ["E2E harness syntax", () => ["scripts/e2e-config.cjs", "scripts/e2e-runner.cjs", "scripts/e2e-server.cjs", "scripts/store-preflight.cjs"].forEach((file) => runNode("--check", [file]))],
    ["board interaction regression", () => runNode("scripts/board-interaction-regression.js")],
    ["site structure", () => runNode("scripts/verify-site.js")]
  ];
  if (full) {
    checks.push(
      ["deploy assets", () => runNode("scripts/check-deploy-assets.js")],
      ["multiplayer regression", () => runNode("scripts/multiplayer-regression.js")],
      ["static build", () => runNode("scripts/build-pages.js")]
    );
  }
  for (const [name, task] of checks) {
    try { task(); pass(`static: ${name}`); } catch (error) { fail(`static: ${name}`, error); }
  }
  const diff = spawnSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
  if (diff.status === 0) pass("static: git diff --check");
  else fail("static: git diff --check", new Error(diff.stdout || diff.stderr || "Whitespace errors detected."));
}

function waitForLocalServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.on("error", retry);
      request.setTimeout(1000, () => { request.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`));
      else setTimeout(attempt, 100);
    };
    attempt();
  });
}

function getPlaywright() {
  try { return require("playwright"); } catch (error) {
    throw new Error("Playwright is not installed. Run npm install, then rerun npm run test:e2e.");
  }
}

async function createBrowser() {
  const { chromium } = getPlaywright();
  const launchOptions = { headless: process.env.E2E_HEADLESS !== "0" };
  if (process.env.E2E_CHROMIUM_PATH) launchOptions.executablePath = process.env.E2E_CHROMIUM_PATH;
  return chromium.launch(launchOptions);
}

async function gotoHash(page, baseUrl, hash) {
  const suffix = hash.startsWith("#") ? hash : `#${hash}`;
  await page.goto(`${baseUrl}/${suffix}`, { waitUntil: "domcontentloaded" });
  // Visual and identity assertions must observe the settled page rather than
  // the brief interval where deferred icon/font resources are still loading.
  await page.waitForLoadState("load").catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  }).catch(() => {});
  await page.waitForTimeout(Number(process.env.E2E_SETTLE_MS || 450));
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function auditIdentity(page, label, expectedStyle = "") {
  const audit = await page.evaluate(() => {
    const alpha = (color) => {
      const match = String(color || "").match(/rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/i);
      return match && match[1] !== undefined ? Number(match[1]) : color === "transparent" ? 0 : 1;
    };
    const lines = [...document.querySelectorAll(".player-identity-line")].filter((line) => {
      const rect = line.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const names = lines.map((line) => {
      const name = line.querySelector("[data-player-identity-name], .styled-username, .player-identity-name, [data-match-name]") || (line.matches("[data-player-identity-name], .styled-username") ? line : null);
      const rect = name?.getBoundingClientRect();
      const style = name ? getComputedStyle(name) : null;
      const lineStyle = getComputedStyle(line);
      const gradientText = Boolean(name && style && (style.backgroundClip === "text" || style.webkitBackgroundClip === "text") && style.backgroundImage && style.backgroundImage !== "none");
      return {
        text: String(name?.textContent || "").trim(),
        owner: line.dataset.identityOwner || "",
        style: line.dataset.identityNameStyle || "",
        visible: Boolean(name && rect?.width > 0 && rect?.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0 && (gradientText || !String(style.color).includes("rgba(0, 0, 0, 0)"))),
        wrapperBackgroundAlpha: alpha(lineStyle.backgroundColor),
        nameBackgroundClip: name ? style.backgroundClip || style.webkitBackgroundClip : "",
        nameColor: name ? style.color : ""
      };
    });
    const fallbackNames = [...document.querySelectorAll('[data-profile-field="name"], [data-account-field="username"], #loginDisplayName')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => ({ text: String(element.textContent || "").trim(), visible: getComputedStyle(element).visibility !== "hidden" && Number(getComputedStyle(element).opacity) > 0, style: element.dataset.identityNameStyle || "" }));
    const currentStyles = names.filter((item) => item.owner === "player" && item.style).map((item) => item.style);
    let storedNameStyle = "";
    try { storedNameStyle = JSON.parse(localStorage.getItem("checkmateQuest.preferences.v1") || "{}").nameStyle || ""; } catch {}
    return { names, fallbackNames, currentStyles, storedNameStyle, width: document.documentElement.scrollWidth, viewport: window.innerWidth };
  });
  assert(audit.names.concat(audit.fallbackNames).every((item) => item.text && item.visible), `${label}: an identity name is empty, hidden, or clipped: ${JSON.stringify(audit)}`);
  assert(audit.names.every((item) => item.wrapperBackgroundAlpha < 0.08), `${label}: an identity wrapper has a visible background; cosmetics must decorate text only.`);
  if (audit.currentStyles.length) assert(new Set(audit.currentStyles).size === 1, `${label}: current-player identities disagree on Name Style: ${audit.currentStyles.join(", ")}`);
  if (expectedStyle) assert(audit.currentStyles.every((style) => style === expectedStyle), `${label}: expected equipped Name Style ${expectedStyle}, found ${audit.currentStyles.join(", ")}; stored=${audit.storedNameStyle}; identities=${JSON.stringify(audit.names.filter((item) => item.owner === "player"))}.`);
  assert(audit.width <= audit.viewport + 4, `${label}: horizontal overflow detected (${audit.width}px > ${audit.viewport}px).`);
  return audit;
}

async function auditVisibleBoards(page, label) {
  const boards = await page.evaluate(() => [...document.querySelectorAll("[role='group'][aria-roledescription='chess board'], .opening-explorer-board")]
    .filter((board) => { const rect = board.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
    .map((board) => {
      const rect = board.getBoundingClientRect();
      const squares = [...board.querySelectorAll("[data-square]")].map((square) => square.getBoundingClientRect());
      const width = squares[0]?.width || 0;
      const height = squares[0]?.height || 0;
      const same = squares.every((item) => Math.abs(item.width - width) < 0.1 && Math.abs(item.height - height) < 0.1);
      return { id: board.id, width: rect.width, height: rect.height, squareCount: squares.length, squareWidth: width, squareHeight: height, same };
    }));
  for (const board of boards) {
    assert(Math.abs(board.width - board.height) < 1, `${label}/${board.id}: board is not square.`);
    assert(board.squareCount === 64, `${label}/${board.id}: expected 64 squares, found ${board.squareCount}.`);
    assert(Math.abs(board.squareWidth - board.squareHeight) < 0.1 && board.same, `${label}/${board.id}: square geometry is inconsistent.`);
  }
  return boards;
}

async function checkVisualSnapshot(page, name, selector = ".site-header") {
  if (process.env.E2E_BREAK_VISUAL === "1") throw new Error("Intentional visual failure requested by E2E_BREAK_VISUAL=1.");
  // A first-visit setup dialog can be shown asynchronously and sits above the
  // sticky header. Dismiss it in the isolated visual-test context so the
  // snapshot represents the navbar rather than a transient onboarding modal.
  const firstVisit = page.locator("#firstVisitSetup");
  if (await firstVisit.isVisible().catch(() => false)) {
    await page.locator("#firstVisitSetupSkip").click().catch(() => {});
    await firstVisit.waitFor({ state: "hidden", timeout: 1000 }).catch(() => {});
  }
  await page.evaluate(() => {
    document.querySelectorAll(".quick-match-overlay").forEach((element) => {
      element.hidden = true;
      element.setAttribute("aria-hidden", "true");
      element.style.setProperty("display", "none", "important");
    });
  });
  await canonicalizeVisualIcons(page);
  // Freeze composited effects before taking a baseline. The header uses a
  // backdrop over animated page-aura pseudo-elements, so Playwright's
  // `animations: disabled` on the target alone cannot make those pixels
  // deterministic. This is test-only and does not change the application.
  await page.addStyleTag({ content: `
    html.e2e-visual-stable *,
    html.e2e-visual-stable *::before,
    html.e2e-visual-stable *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
    }
  ` });
  await page.evaluate(() => document.documentElement.classList.add("e2e-visual-stable"));
  await page.waitForTimeout(30);
  const bytes = await page.locator(selector).screenshot({ animations: "disabled" });
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifact = path.join(artifactDir, `${name}.png`);
  fs.writeFileSync(artifact, bytes);
  assert(bytes.length > 1000, `${name}: screenshot is unexpectedly empty.`);
  const baseline = path.join(snapshotDir, `${name}.png`);
  if (process.env.E2E_UPDATE_SNAPSHOTS === "1") {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(baseline, bytes);
    console.log(`UPDATED visual baseline ${path.relative(root, baseline)}`);
  } else if (fs.existsSync(baseline)) {
    const expected = fs.readFileSync(baseline);
    const comparison = compareScreenshotBytes(expected, bytes);
    assert(comparison.matches, `${name}: screenshot differs from the checked-in visual baseline (${comparison.reason || "pixel mismatch"}). Set E2E_UPDATE_SNAPSHOTS=1 only after reviewing the change.`);
  } else {
    skip(`visual:${name}`, "baseline missing; run E2E_UPDATE_SNAPSHOTS=1 once after visual review");
  }
}

async function drawAndToggleManualArrow(page, boardSelector, label) {
  const board = page.locator(boardSelector).first();
  if (!(await board.isVisible().catch(() => false))) return;
  const squares = board.locator("[data-square]");
  assert(await squares.count() === 64, `${label}: expected a 64-square board before drawing.`);
  const from = await squares.nth(0).boundingBox();
  const to = await squares.nth(9).boundingBox();
  assert(from && to, `${label}: could not measure arrow endpoints.`);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(60);
  const countAfterDraw = await board.locator('[data-analysis-layer="arrows"] [data-arrow-id], .review-arrow-group').count();
  assert(countAfterDraw >= 1, `${label}: right-click drag did not create a manual arrow.`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(60);
  const countAfterToggle = await board.locator('[data-analysis-layer="arrows"] [data-arrow-id], .review-arrow-group').count();
  assert(countAfterToggle === 0, `${label}: drawing the same route did not toggle the arrow off.`);
}

async function readAuthRuntimeSnapshot(page) {
  return page.evaluate(async () => {
    const client = window.CheckmateQuestSupabaseClient?.client;
    let session = { present: false, userId: "", error: "" };
    if (client?.auth?.getSession) {
      try {
        const result = await client.auth.getSession();
        const userId = String(result?.data?.session?.user?.id || "");
        session = {
          present: Boolean(userId),
          userId: userId ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : "",
          error: result?.error?.message || ""
        };
      } catch (error) {
        session.error = String(error?.message || error || "unknown");
      }
    }
    return {
      url: location.href,
      hash: location.hash,
      authState: document.documentElement.dataset.authState || "",
      providerReady: Boolean(window.CheckmateQuestAuthProvider),
      supabaseClientReady: Boolean(client),
      session,
      loginVisible: !document.getElementById("authLoginForm")?.hidden,
      loginHidden: Boolean(document.getElementById("authLoginForm")?.hidden),
      accountHidden: Boolean(document.getElementById("authAccountPanel")?.hidden),
      accountName: document.getElementById("authAccountName")?.textContent || "",
      accountEmail: document.getElementById("authAccountEmail")?.textContent || "",
      authStatus: document.getElementById("authStatus")?.textContent || ""
    };
  }).catch(() => ({}));
}

async function waitForAuthHydration(page, label) {
  try {
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.authState;
      return state === "authenticated" || state === "guest" || state === "error";
    }, null, { timeout: 15000 });
  } catch (error) {
    const snapshot = await readAuthRuntimeSnapshot(page);
    throw new Error(`${label} auth state did not settle: ${JSON.stringify({ timeout: error.message, snapshot })}`);
  }
}

async function waitForStoreHydration(page, label) {
  try {
    await page.waitForFunction(() => {
      const authState = document.documentElement.dataset.authState;
      const storeState = document.documentElement.dataset.storeSyncStatus;
      return authState !== "authenticated" || storeState === "ready" || storeState === "error";
    }, null, { timeout: 15000 });
  } catch (error) {
    const snapshot = await readAuthRuntimeSnapshot(page);
    throw new Error(`${label} Store state did not settle: ${JSON.stringify({ timeout: error.message, snapshot, storeSyncStatus: await page.evaluate(() => document.documentElement.dataset.storeSyncStatus || "") })}`);
  }
}

async function prepareAuth(browser, baseUrl, email, password, label) {
  if (!email || !password) return null;
  const envSummary = authEnvironmentSummary(email, password, baseUrl);
  console.log(`[e2e auth] ${label} environment`, envSummary);
  if (envSummary.emailLooksPlaceholder || envSummary.passwordLooksPlaceholder) {
    throw new Error(`Dedicated E2E credentials are still placeholders in ${envFile}. Replace E2E_EMAIL/E2E_PASSWORD with a real disposable test account; no password was printed.`);
  }
  const statePath = path.join(root, ".playwright", "auth", `${label}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (fs.existsSync(statePath)) {
    const cachedContext = await browser.newContext({ storageState: statePath });
    const cachedPage = await cachedContext.newPage();
    await gotoHash(cachedPage, baseUrl, "#login");
    const cachedAuth = await readAuthRuntimeSnapshot(cachedPage);
    await cachedContext.close();
    if (cachedAuth.authState === "authenticated"
      && cachedAuth.accountEmail.trim().toLowerCase() === String(email).trim().toLowerCase()
      && cachedAuth.accountName.trim()
      && cachedAuth.accountName.trim() !== "Guest Explorer") return statePath;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  const trace = { consoleErrors: [], pageErrors: [], requestFailures: [], authResponses: [] };
  page.on("console", (message) => {
    if (message.type() === "error") trace.consoleErrors.push(redactDiagnosticText(message.text()));
  });
  page.on("pageerror", (error) => trace.pageErrors.push(redactDiagnosticText(error.message || error)));
  page.on("requestfailed", (request) => {
    if (/auth-config|supabase|auth\/v1|rest\/v1/i.test(request.url())) trace.requestFailures.push({ url: redactTraceUrl(request.url()), failure: request.failure()?.errorText || "unknown" });
  });
  page.on("response", (response) => {
    if (/auth-config|supabase|auth\/v1|rest\/v1/i.test(response.url())) trace.authResponses.push({ url: redactTraceUrl(response.url()), status: response.status() });
  });
  await gotoHash(page, baseUrl, "#login");
  const initialSnapshot = await readAuthRuntimeSnapshot(page);
  console.log(`[e2e auth] ${label} initial runtime`, { ...initialSnapshot, trace: trace.authResponses.slice(-5) });
  const alreadyAuthenticated = initialSnapshot.authState === "authenticated";
  if (!alreadyAuthenticated) {
    const loginTab = page.locator('[data-auth-tab="login"]');
    if (!(await loginTab.isVisible().catch(() => false))) {
      throw new Error(`E2E auth login control is unavailable; refusing to wait on the authenticated signal. ${JSON.stringify({ snapshot: initialSnapshot, trace })}`);
    }
    await loginTab.click();
    await page.locator("#authLoginEmail").fill(email);
    await page.locator("#authLoginPassword").fill(password);
    await page.locator("#authLoginForm button[type=submit]").click();
    try {
      await page.waitForFunction(() => {
        const state = document.documentElement.dataset.authState;
        const status = document.getElementById("authStatus");
        const statusText = String(status?.textContent || "");
        return (state === "authenticated" && !document.getElementById("authAccountPanel")?.hidden)
          || status?.classList.contains("is-error")
          || /unavailable|could not|failed|invalid|password|account/i.test(statusText);
      }, null, { timeout: 10000 });
    } catch (error) {
      const snapshot = await readAuthRuntimeSnapshot(page);
      snapshot.localStorageKeys = await page.evaluate(() => Object.keys(localStorage).filter((key) => /supabase|auth/i.test(key)).slice(0, 12)).catch(() => []);
      throw new Error(`E2E auth did not settle at prepareAuth wait. ${JSON.stringify({ timeout: error.message, snapshot, trace })}`);
    }
    const finalSnapshot = await readAuthRuntimeSnapshot(page);
    if (finalSnapshot.authState !== "authenticated"
      || finalSnapshot.accountHidden
      || !finalSnapshot.accountName.trim()
      || finalSnapshot.accountName.trim() === "Guest Explorer"
      || finalSnapshot.accountEmail.trim().toLowerCase() !== String(email).trim().toLowerCase()) {
      throw new Error(`E2E login returned without an authenticated account. ${JSON.stringify({ snapshot: finalSnapshot, trace })}`);
    }
  }
  await context.storageState({ path: statePath });
  await context.close();
  return statePath;
}

async function runGuestBrowserTests(browser, baseUrl, viewports) {
  const routes = [
    ["home", "#top", "#top"],
    ["profile", "#login", "#loginDisplayName"],
    ["play", "#play", "#coachBoard"],
    ["tournaments", "#play?mode=tournament", "#coachBoard"],
    ["puzzles", "#puzzles", "#puzzleBoard"],
    ["openings", "#openings", "#openingExplorerBoard"],
    ["store", "#store", "#storeGrid"],
    ["friends", "#friends", "#friendsHubList"],
    ["leaderboards", "#leaderboards", "#puzzleLeaderboardList"]
  ];
  for (const [width, height] of viewports) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await stabilizeVisualContext(context);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    for (const [name, hash, readySelector] of routes) {
      await gotoHash(page, baseUrl, hash);
      await page.locator(readySelector).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      if (/Board$/.test(readySelector)) {
        await page.locator(`${readySelector} [data-square]`).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
      }
      await auditIdentity(page, `${name}@${width}`);
      await auditVisibleBoards(page, `${name}@${width}`);
      if (name === "home") await checkVisualSnapshot(page, `navbar-${width}`, ".site-header");
    }
    await gotoHash(page, baseUrl, "#puzzles");
    await drawAndToggleManualArrow(page, "#puzzleBoard", `puzzles@${width}`);
    assert(consoleErrors.length === 0, `browser console errors at ${width}px: ${consoleErrors.join(" | ")}`);
    await context.close();
    pass(`browser: guest routes and responsive identity/board audit @ ${width}px`);
  }
}

async function runAuthenticatedBrowserTests(browser, baseUrl, primaryState, secondState) {
  if (!primaryState) {
    const reason = "E2E_EMAIL/E2E_PASSWORD are not configured in .env.e2e";
    if (required) throw new Error(reason);
    skip("browser: authenticated session/store/identity tests", reason);
    return;
  }
  const context = await browser.newContext({ storageState: primaryState, viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  await gotoHash(page, baseUrl, "#login");
  await waitForAuthHydration(page, "primary");
  await waitForStoreHydration(page, "primary");
  const auth = await readAuthRuntimeSnapshot(page);
  assert(auth.authState === "authenticated"
    && auth.accountHidden === false
    && auth.accountName.trim()
    && auth.accountName.trim() !== "Guest Explorer"
    && auth.session.present
    && auth.supabaseClientReady,
  `authenticated session did not hydrate through Supabase: ${JSON.stringify(auth)}`);
  pass("browser: authenticated Supabase session and account identity (not Guest Explorer)");

  const expectedStyle = String(process.env.E2E_EXPECTED_NAME_STYLE || "").trim();
  const modes = ["#play", "#bots", "#puzzles", "#openings", "#gameReview", "#leaderboards", "#friends", "#store"];
  for (const hash of modes) {
    await gotoHash(page, baseUrl, hash);
    await waitForAuthHydration(page, `primary ${hash}`);
    await waitForStoreHydration(page, `primary ${hash}`);
    await auditIdentity(page, `authenticated${hash}`, expectedStyle);
  }
  pass("browser: equipped Name Style pipeline across mounted modes");

  if (secondState) {
    const secondContext = await browser.newContext({ storageState: secondState, viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
    const secondPage = await secondContext.newPage();
    await gotoHash(secondPage, baseUrl, "#login");
    await waitForAuthHydration(secondPage, "secondary");
    await waitForStoreHydration(secondPage, "secondary");
    const secondExpectedStyle = String(process.env.E2E_SECOND_EXPECTED_NAME_STYLE || "").trim();
    await auditIdentity(secondPage, "second-account mobile identity", secondExpectedStyle);
    if (expectedStyle && secondExpectedStyle) assert(expectedStyle !== secondExpectedStyle, "The two dedicated accounts must use distinct expected Name Styles for identity isolation coverage.");
    await secondContext.close();
    pass("browser: second dedicated account identity isolation");
  } else skip("browser: second-account identity isolation", "E2E_SECOND_EMAIL/E2E_SECOND_PASSWORD are not configured");

  const purchaseId = String(process.env.E2E_PURCHASE_ITEM_ID || "").trim();
  if (!purchaseId) {
    skip("browser: Store purchase transaction", "E2E_PURCHASE_ITEM_ID is not configured");
  } else {
    await gotoHash(page, baseUrl, "#store");
    let card = page.locator(`[data-store-item-id="${purchaseId}"]`).first();
    if (await card.count() === 0 && /^lastmove-/.test(purchaseId)) {
      await page.locator(".store-category-tab").filter({ hasText: "Highlights" }).first().click();
      await page.waitForTimeout(120);
      card = page.locator(`[data-store-item-id="${purchaseId}"]`).first();
    }
    assert(await card.count() === 1, `configured Store item ${purchaseId} is not rendered.`);
    const action = card.locator("[data-store-item-action]").first();
    if (await card.evaluate((element) => element.classList.contains("is-owned")).catch(() => false)) {
      skip(`browser: Store purchase transaction (${purchaseId})`, "configured item is already owned by the dedicated account; choose an unowned low-cost item");
    } else {
      const beforeText = await page.locator("#storeCoinBalance").textContent();
      const serverEvidence = await page.evaluate(async () => {
        const client = window.CheckmateQuestSupabaseClient?.client;
        const result = await client?.auth?.getUser?.();
        const keys = Object.keys(localStorage);
        return {
          authUserPresent: Boolean(result?.data?.user?.id),
          authUserId: result?.data?.user?.id ? `${String(result.data.user.id).slice(0, 8)}…${String(result.data.user.id).slice(-4)}` : "",
          localPuzzleCoinsKey: keys.some((key) => /puzzleCoins/i.test(key)),
          guestAccountVisible: String(document.getElementById("authAccountName")?.textContent || "").trim() === "Guest Explorer"
        };
      });
      assert(serverEvidence.authUserPresent && !serverEvidence.guestAccountVisible, `Store test is not running as an authenticated user: ${JSON.stringify(serverEvidence)}`);
      const requestUrls = [];
      const rpcRequests = [];
      const rpcResponses = [];
      page.on("request", (request) => {
        if (!/purchase_cosmetic/.test(request.url())) return;
        requestUrls.push(request.url());
        let payload = null;
        try { payload = request.postDataJSON(); } catch {}
        rpcRequests.push(payload);
      });
      page.on("response", async (response) => {
        if (!/purchase_cosmetic/.test(response.url())) return;
        let body = null;
        try { body = await response.json(); } catch {}
        rpcResponses.push({ status: response.status(), body });
      });
      await action.click();
      const pendingSeen = await action.evaluate((element) => element.disabled || element.classList.contains("is-pending") || element.closest(".store-card")?.classList.contains("is-pending")).catch(() => false);
      await action.click().catch(() => {});
      await page.waitForTimeout(150);
      assert(pendingSeen || requestUrls.length > 0, "Store Buy did not show a pending state or issue a purchase request promptly.");
      await page.waitForTimeout(2500);
      assert(requestUrls.length === 1, `authenticated Store purchase should issue exactly one RPC request; saw ${requestUrls.length}.`);
      assert(rpcRequests[0]?.p_item_id === purchaseId && String(rpcRequests[0]?.p_idempotency_key || "").length >= 8, "purchase_cosmetic received an invalid item or idempotency payload.");
      assert(rpcResponses.length === 1 && rpcResponses[0].status >= 200 && rpcResponses[0].status < 300, `purchase_cosmetic did not return success: ${JSON.stringify(rpcResponses)}`);
      const statusDiagnostic = await page.locator("#storeStatus").getAttribute("data-purchase-diagnostic").catch(() => "");
      assert(statusDiagnostic !== "LOCAL_FALLBACK", "Authenticated Store test used the local/guest wallet path.");
      const statusText = await page.locator("#storeStatus").textContent().catch(() => "");
      assert(!/failed|rejected|could not|error/i.test(statusText), `Store purchase returned an error: ${statusText}`);
      const owned = await card.evaluate((element) => element.classList.contains("is-owned") || /owned|equipped/i.test(element.textContent || ""));
      assert(owned, `Store item ${purchaseId} did not become owned after purchase.`);
      const afterText = await page.locator("#storeCoinBalance").textContent();
      assert(beforeText !== afterText, `Store balance did not update after purchasing ${purchaseId}.`);
      const expectedPrice = Number(process.env.E2E_PURCHASE_ITEM_PRICE || 0);
      if (expectedPrice > 0) {
        const before = Number(String(beforeText).replace(/[^0-9.-]/g, ""));
        const after = Number(String(afterText).replace(/[^0-9.-]/g, ""));
        assert(before - after === expectedPrice, `Store wallet delta was ${before - after}; expected ${expectedPrice}.`);
        const rpcBody = Array.isArray(rpcResponses[0].body) ? rpcResponses[0].body[0] : rpcResponses[0].body;
        assert(Number(rpcBody?.coins) === after, `Store UI balance ${after} did not match the RPC server balance.`);
      }
      const rpcResult = Array.isArray(rpcResponses[0].body) ? rpcResponses[0].body[0] : rpcResponses[0].body;
      console.log(`[e2e purchase proof] ${JSON.stringify({
        itemId: purchaseId,
        balanceBefore: Number(String(beforeText).replace(/[^0-9.-]/g, "")),
        price: Number(process.env.E2E_PURCHASE_ITEM_PRICE || 0),
        balanceAfter: Number(String(afterText).replace(/[^0-9.-]/g, "")),
        rpcStatus: rpcResponses[0].status,
        rpcCoins: Number(rpcResult?.coins),
        rpcCalls: requestUrls.length,
        localFallback: false,
        owned: true
      })}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await gotoHash(page, baseUrl, "#store");
      let refreshedCard = page.locator(`[data-store-item-id="${purchaseId}"]`).first();
      if (await refreshedCard.count() === 0 && /^lastmove-/.test(purchaseId)) {
        await page.locator(".store-category-tab").filter({ hasText: "Highlights" }).first().click();
        await page.waitForTimeout(120);
        refreshedCard = page.locator(`[data-store-item-id="${purchaseId}"]`).first();
      }
      await refreshedCard.waitFor({ state: "visible", timeout: 10000 });
      assert(await refreshedCard.evaluate((element) => element.classList.contains("is-owned")), `Store ownership for ${purchaseId} did not persist after refresh.`);
      if (!(await refreshedCard.evaluate((element) => element.classList.contains("is-equipped")))) {
        const equipRequests = [];
        const equipResponses = [];
        const onEquipRequest = (request) => {
          if (!/equip_cosmetic/.test(request.url())) return;
          let payload = null;
          try { payload = request.postDataJSON(); } catch {}
          equipRequests.push(payload);
        };
        const onEquipResponse = async (response) => {
          if (!/equip_cosmetic/.test(response.url())) return;
          let body = null;
          try { body = await response.json(); } catch {}
          equipResponses.push({ status: response.status(), body });
        };
        page.on("request", onEquipRequest);
        page.on("response", onEquipResponse);
        await refreshedCard.locator("[data-store-item-action]").first().click();
        await page.waitForTimeout(1000);
        page.off("request", onEquipRequest);
        page.off("response", onEquipResponse);
        if (!(await refreshedCard.evaluate((element) => element.classList.contains("is-equipped") || /equipped/i.test(element.textContent || "")))) {
          const statusAfterEquip = await page.locator("#storeStatus").textContent().catch(() => "");
          throw new Error(`Store item ${purchaseId} could not be equipped after refresh. status=${statusAfterEquip}; equipRequests=${JSON.stringify(equipRequests)}; equipResponses=${JSON.stringify(equipResponses)}`);
        }
      }
      pass(`browser: authenticated Store purchase, pending state, ownership, and wallet update (${purchaseId})`);
    }
  }

  const failureId = String(process.env.E2E_FAILURE_ITEM_ID || "").trim();
  if (!failureId) {
    skip("browser: Store failure handling", "E2E_FAILURE_ITEM_ID is not configured");
  } else {
    await gotoHash(page, baseUrl, "#store");
    let failureCard = page.locator(`[data-store-item-id="${failureId}"]`).first();
    if (await failureCard.count() === 0 && /^lastmove-/.test(failureId)) {
      await page.locator(".store-category-tab").filter({ hasText: "Highlights" }).first().click();
      await page.waitForTimeout(120);
      failureCard = page.locator(`[data-store-item-id="${failureId}"]`).first();
    }
    assert(await failureCard.count() === 1, `configured Store failure item ${failureId} is not rendered.`);
    if (await failureCard.evaluate((element) => element.classList.contains("is-owned")).catch(() => false)) {
      skip(`browser: Store failure handling (${failureId})`, "configured failure item is already owned; choose an unowned item");
    } else {
      const failureAction = failureCard.locator("[data-store-item-action]").first();
      const failureBeforeCoins = await page.locator("#storeCoinBalance").textContent();
      await page.route("**/rest/v1/rpc/purchase_cosmetic", (route) => route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ code: "E2E_INTENTIONAL_FAILURE", message: "intentional E2E failure" })
      }));
      await failureAction.click();
      await page.waitForFunction(() => /RPC_FAILED|rejected|could not|failed/i.test(document.getElementById("storeStatus")?.textContent || ""), null, { timeout: 10000 });
      const failureStatus = await page.locator("#storeStatus").textContent();
      assert(/RPC_FAILED|rejected|could not|failed/i.test(failureStatus), `Store failure was not exposed clearly: ${failureStatus}`);
      assert(await page.locator("#storeCoinBalance").textContent() === failureBeforeCoins, "A rejected Store purchase changed the wallet locally.");
      assert(!(await failureCard.evaluate((element) => element.classList.contains("is-owned"))), "A rejected Store purchase created local ownership.");
      await page.unroute("**/rest/v1/rpc/purchase_cosmetic");
      pass(`browser: Store RPC failure is surfaced without a silent no-op (${failureId})`);
    }
  }

  const logoutContext = await browser.newContext({ storageState: primaryState, viewport: { width: 1024, height: 800 }, serviceWorkers: "allow" });
  const logoutPage = await logoutContext.newPage();
  await gotoHash(logoutPage, baseUrl, "#login");
  await logoutPage.locator("#authPanelLogout").click();
  await logoutPage.waitForFunction(() => document.documentElement.dataset.authState !== "authenticated", null, { timeout: 10000 });
  pass("browser: logout clears the authenticated session");
  await logoutContext.close();
  await context.close();
}

async function runVisualSmokeTests(browser, baseUrl) {
  for (const [width, height] of [[1366, 900], [1024, 800], [768, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await stabilizeVisualContext(context);
    const page = await context.newPage();
    await gotoHash(page, baseUrl, "#top");
    await auditIdentity(page, `visual@${width}`);
    await checkVisualSnapshot(page, `navbar-${width}`, ".site-header");
    await context.close();
    pass(`visual: navbar identity @ ${width}px`);
  }
}

async function runBrowserTests() {
  let server = null;
  const configuredBaseUrl = String(process.env.E2E_BASE_URL || "").trim();
  const local = !configuredBaseUrl || /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(configuredBaseUrl.replace(/\/$/, ""));
  const port = Number(process.env.E2E_PORT || 4173);
  const baseUrl = (configuredBaseUrl || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  if (required && (!process.env.E2E_EMAIL || !process.env.E2E_PASSWORD)) {
    throw new Error(`Authenticated E2E tests are required but ${envFile} does not contain E2E_EMAIL and E2E_PASSWORD. Copy .env.e2e.example, use dedicated test accounts, and retry.`);
  }
  const localSupabase = discoverSupabaseConfig();
  if (!visualOnly && local && process.env.E2E_EMAIL && process.env.E2E_PASSWORD && (!localSupabase.hasUrl || !localSupabase.hasAnonKey)) {
    const missing = [!localSupabase.hasUrl ? "public Supabase URL" : "", !localSupabase.hasAnonKey ? "public Supabase anon/publishable key" : ""].filter(Boolean).join(" and ");
    throw new Error(`Local E2E auth cannot initialize Supabase: ${missing} is not discoverable from project config or ${envFile}. Set only the missing public value; the local server will return E2E_SUPABASE_NOT_CONFIGURED instead of falling back to Guest Explorer.`);
  }
  if (local) {
    server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => process.stdout.write(`[e2e-server] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[e2e-server] ${chunk}`));
    await waitForLocalServer(baseUrl);
  }
  let browser = null;
  try {
    browser = await createBrowser();
    if (visualOnly) {
      await runVisualSmokeTests(browser, baseUrl);
      return;
    }
    const primaryState = await prepareAuth(browser, baseUrl, process.env.E2E_EMAIL, process.env.E2E_PASSWORD, "primary");
    const secondState = await prepareAuth(browser, baseUrl, process.env.E2E_SECOND_EMAIL, process.env.E2E_SECOND_PASSWORD, "secondary");
    await runGuestBrowserTests(browser, baseUrl, [[1366, 900], [1024, 800], [768, 900], [390, 844]]);
    await runAuthenticatedBrowserTests(browser, baseUrl, primaryState, secondState);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

function printSummary() {
  console.log(`\nE2E summary: ${results.passed.length} passed, ${results.skipped.length} skipped, ${results.failed.length} failed.`);
  if (results.skipped.length) results.skipped.forEach((entry) => console.log(`  ${entry}`));
  if (results.failed.length || (required && results.skipped.length)) process.exitCode = 1;
}

async function main() {
  const full = mode === "full";
  if (mode !== "e2e" && mode !== "visual") {
    const files = changedFiles();
    const appAffected = full || files.length === 0 || files.some((file) => /^(index\.html|assets\/|service-worker\.js|tests\/e2e\/|scripts\/e2e-)/.test(file));
    runStaticChecks(full);
    const purchaseTestConfigured = Boolean(String(process.env.E2E_PURCHASE_ITEM_ID || "").trim());
    // Any run that can execute a real Store purchase must prove the disposable
    // account's authoritative wallet first. This prevents affected-only runs
    // from silently exercising a guest/localStorage purchase path.
    if (full || purchaseTestConfigured) {
      try {
        runNode("scripts/store-preflight.cjs");
        pass("static: authoritative Store budget preflight");
      } catch (error) {
        fail("static: authoritative Store budget preflight", error);
        if (required || purchaseTestConfigured) {
          printSummary();
          return;
        }
      }
    }
    if (!appAffected && mode === "affected") skip("browser: affected E2E", "changed files do not touch the application or E2E harness");
    else await runBrowserTests();
  } else {
    await runBrowserTests();
  }
  printSummary();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
