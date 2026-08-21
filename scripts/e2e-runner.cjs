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
    ["E2E harness syntax", () => ["scripts/e2e-config.cjs", "scripts/e2e-runner.cjs", "scripts/e2e-server.cjs", "scripts/store-preflight.cjs", "scripts/oauth-auth-regression.js"].forEach((file) => runNode("--check", [file]))],
    ["OAuth redirect policy", () => runNode("scripts/oauth-auth-regression.js")],
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
        className: name?.className || "",
        nameStyle: name?.dataset?.nameStyle || "",
        nameRarity: name?.dataset?.rarity || "",
        nameLive: name?.dataset?.nameLive || "",
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

async function readIdentityVisualState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element?.getBoundingClientRect?.();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(element && rect?.width > 0 && rect?.height > 0 && style?.visibility !== "hidden" && Number(style?.opacity || 0) > 0);
    };
    const read = (line) => {
      // Do not use a selector list with a generic `span` fallback here.  CSS
      // querySelector returns the first matching node in document order, so a
      // country-flag span can win over the actual username even when the name
      // selector appears first in the list.  Identity renderers mark the
      // username explicitly; use those markers in priority order and only
      // retain semantic fallbacks for legacy surfaces.
      const lineIsName = line.matches("[data-player-identity-name], [data-match-name], [data-profile-field=\"name\"], #loginDisplayName");
      const name = lineIsName ? line : line.querySelector("[data-player-identity-name]")
        || line.querySelector("[data-match-name]")
        || line.querySelector("[data-profile-field=\"name\"]")
        || line.querySelector("#loginDisplayName")
        || line.querySelector("strong");
      const style = name ? getComputedStyle(name) : null;
      const shell = line.closest(".player-identity-shell") || line;
      const shellStyle = getComputedStyle(shell);
      return {
        text: String(name?.textContent || "").trim(),
        className: name?.className || "",
        nameDatasetStyle: name?.dataset?.nameStyle || "",
        nameDatasetRarity: name?.dataset?.rarity || "",
        nameDatasetLive: name?.dataset?.nameLive || "",
        style: line.dataset.identityNameStyle || "",
        visible: visible(name),
        backgroundImage: style?.backgroundImage || "",
        backgroundClip: style?.backgroundClip || style?.webkitBackgroundClip || "",
        color: style?.color || "",
        textFill: style?.webkitTextFillColor || "",
        textShadow: style?.textShadow || "",
        fontWeight: style?.fontWeight || "",
        letterSpacing: style?.letterSpacing || "",
        animationName: style?.animationName || "",
        animationDuration: style?.animationDuration || "",
        wrapperBackground: shellStyle?.backgroundColor || "",
        wrapperOverflow: shellStyle?.overflow || "",
        wrapperIsName: shell === name,
        nameOverflowsWrapper: Boolean(name && shell && shellStyle?.display !== "contents" && (() => {
          const nameRect = name.getBoundingClientRect();
          const shellRect = shell.getBoundingClientRect();
          return nameRect.left < shellRect.left - 1.5
            || nameRect.right > shellRect.right + 1.5
            || nameRect.top < shellRect.top - 1.5
            || nameRect.bottom > shellRect.bottom + 1.5;
        })())
      };
    };
    const lines = [...document.querySelectorAll(".player-identity-line")].filter(visible);
    const player = lines.filter((line) => line.dataset.identityOwner === "player").map(read);
    const remote = lines.filter((line) => line.dataset.identityOwner === "remote").map(read);
    return { player, remote, viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
}

function assertIdentityVisualConsistency(state, label, expectedStyle = "") {
  assert(state.player.length > 0, `${label}: no visible current-player identity was mounted.`);
  assert(state.player.every((item) => item.text && item.visible), `${label}: a current-player name is empty or hidden: ${JSON.stringify(state.player)}`);
  const styles = [...new Set(state.player.map((item) => item.style).filter(Boolean))];
  assert(styles.length === 1, `${label}: current-player Name Styles disagree: ${styles.join(", ")}`);
  if (expectedStyle) assert(styles[0] === expectedStyle, `${label}: expected ${expectedStyle}, found ${styles[0]}.`);
  const tokenKeys = ["backgroundImage", "backgroundClip", "color", "textFill", "textShadow", "fontWeight", "letterSpacing", "animationName", "animationDuration"];
  const baseline = state.player[0];
  state.player.slice(1).forEach((item) => tokenKeys.forEach((key) => assert(item[key] === baseline[key], `${label}: ${key} differs between mounted current-player identities (baseline=${JSON.stringify(baseline[key])}, current=${JSON.stringify(item[key])}).`)));
  assert(state.player.every((item) => {
    const hasDecorativeEffect = item.backgroundImage !== "none"
      || item.textShadow !== "none"
      || item.animationName !== "none";
    // Cards such as Player Pass and the compact profile intentionally use
    // overflow clipping for their own scroll/rounded-surface behavior. That
    // is only a cosmetic regression when the styled name actually extends
    // beyond that shell (or the shell itself is the styled name). Verify the
    // rendered geometry rather than rejecting every intentional scroll card.
    return !hasDecorativeEffect || !item.nameOverflowsWrapper || item.wrapperIsName;
  }), `${label}: identity effect may be clipped by a hidden overflow wrapper: ${JSON.stringify(state.player)}.`);
  assert(state.scrollWidth <= state.viewport + 4, `${label}: identity layout overflows viewport (${state.scrollWidth}px > ${state.viewport}px).`);
  return state;
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

async function waitForAuthenticatedHydration(page, label) {
  try {
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.authState;
      return state === "authenticated" && !document.getElementById("authAccountPanel")?.hidden;
    }, null, { timeout: 15000 });
  } catch (error) {
    const snapshot = await readAuthRuntimeSnapshot(page);
    throw new Error(`${label} authenticated state did not settle: ${JSON.stringify({ timeout: error.message, snapshot })}`);
  }
  const snapshot = await readAuthRuntimeSnapshot(page);
  assert(snapshot.session?.present && snapshot.supabaseClientReady && snapshot.accountName.trim() && snapshot.accountName.trim() !== "Guest Explorer", `${label} resolved without a live authenticated Supabase session: ${JSON.stringify(snapshot)}`);
  return snapshot;
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
      && cachedAuth.session?.present
      && cachedAuth.supabaseClientReady
      && cachedAuth.accountHidden === false
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
    // The auth tab only toggles local markup; waiting for a navigation after
    // this click can hang when Supabase is still hydrating.  Trigger the
    // semantic click without Playwright's navigation wait, then continue to
    // the form readiness check below.
    await loginTab.click({ noWaitAfter: true, timeout: 10000 });
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

async function runOAuthButtonTests(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const waitForOauthUi = async () => {
    await gotoHash(page, baseUrl, "#login");
    await page.waitForFunction(() => Boolean(
      window.CheckmateQuestAuthProvider?.startOAuthLogin
      && window.CheckmateQuestSupabaseClient?.client?.auth?.signInWithOAuth
      && document.getElementById("authGoogleLogin")
    ), null, { timeout: 15000 });
  };
  const intercept = async (result) => page.evaluate((nextResult) => {
    const client = window.CheckmateQuestSupabaseClient.client;
    window.__nschessOauthCalls = [];
    client.auth.signInWithOAuth = async (options) => {
      window.__nschessOauthCalls.push(JSON.parse(JSON.stringify(options)));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return nextResult;
    };
  }, result);
  const runProvider = async (providerName) => {
    await waitForOauthUi();
    await intercept({ data: { url: "https://provider.example/redirect" }, error: null });
    const button = page.locator(`[data-auth-oauth-provider="${providerName}"]`);
    await button.click({ noWaitAfter: true });
    await page.waitForFunction((provider) => {
      const target = document.querySelector(`[data-auth-oauth-provider="${provider}"]`);
      return target?.getAttribute("aria-busy") === "true" && target.disabled;
    }, providerName, { timeout: 3000 });
    // A DOM-dispatched second click deliberately bypasses the native disabled
    // guard and verifies the app's in-flight lock still prevents a duplicate.
    await page.evaluate((provider) => document.querySelector(`[data-auth-oauth-provider="${provider}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })), providerName);
    await page.waitForTimeout(180);
    const calls = await page.evaluate(() => window.__nschessOauthCalls || []);
    assert(calls.length === 1, `${providerName} OAuth was started ${calls.length} times after a duplicate click.`);
    assert(calls[0].provider === providerName, `${providerName} button used ${calls[0].provider || "no"} provider.`);
    assert(calls[0].options?.redirectTo === `${baseUrl}/?auth=oauth`, `${providerName} redirect was not the reviewed local root: ${calls[0].options?.redirectTo || "missing"}`);
  };

  try {
    await runProvider("google");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForOauthUi();
    await intercept({ data: null, error: { code: "provider_disabled", message: "Provider is not enabled" } });
    await page.locator('[data-auth-oauth-provider="google"]').click({ noWaitAfter: true });
    await page.waitForFunction(() => document.getElementById("authStatus")?.classList.contains("is-error"), null, { timeout: 4000 });
    const errorState = await page.evaluate(() => ({
      text: document.getElementById("authStatus")?.textContent || "",
      googleDisabled: document.getElementById("authGoogleLogin")?.disabled
    }));
    assert(/not enabled yet/i.test(errorState.text), `OAuth provider failure was not safely explained: ${errorState.text}`);
    assert(!errorState.googleDisabled, "Google OAuth button remained locked after provider failure.");
    pass("browser: Google OAuth button uses the shared Supabase provider, trusted redirect, pending lock, and safe failure UI");
  } finally {
    await context.close();
  }
}

async function runGuestBrowserTests(browser, baseUrl, viewports) {
  const routes = [
    ["home", "#top", "#top"],
    ["profile", "#login", "#loginDisplayName"],
    ["play", "#play", "#coachBoard"],
    ["tournaments", "#play?mode=tournament", "#coachBoard"],
    ["puzzles", "#puzzles", "#realPuzzleBoard"],
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
        // Route containers appear before their deferred board engines mount.
        // Wait for the exact geometry audit precondition rather than silently
        // ignoring a one-square readiness timeout and racing a 64-square
        // assertion below.
        try {
          await page.waitForFunction((selector) => document.querySelector(selector)?.querySelectorAll("[data-square]").length === 64, readySelector, { timeout: 15000 });
        } catch (error) {
          const readiness = await page.evaluate((selector) => {
            const board = document.querySelector(selector);
            return {
              selector,
              route: location.hash,
              boardPresent: Boolean(board),
              boardVisible: Boolean(board && board.getBoundingClientRect().width && board.getBoundingClientRect().height),
              squares: board?.querySelectorAll("[data-square]").length || 0,
              authState: document.documentElement.dataset.authState || "",
              storeSyncStatus: document.documentElement.dataset.storeSyncStatus || ""
            };
          }, readySelector).catch(() => ({}));
          throw new Error(`${name}@${width}: board did not reach 64 squares before audit: ${JSON.stringify({ readiness, timeout: error.message, consoleErrors })}`);
        }
      }
      await auditIdentity(page, `${name}@${width}`);
      await auditVisibleBoards(page, `${name}@${width}`);
      if (name === "home") await checkVisualSnapshot(page, `navbar-${width}`, ".site-header");
    }
    await gotoHash(page, baseUrl, "#puzzles");
    await drawAndToggleManualArrow(page, "#realPuzzleBoard", `puzzles@${width}`);
    assert(consoleErrors.length === 0, `browser console errors at ${width}px: ${consoleErrors.join(" | ")}`);
    await context.close();
    pass(`browser: guest routes and responsive identity/board audit @ ${width}px`);
  }
}

async function findStoreItemCard(page, itemId) {
  let card = page.locator(`[data-store-item-id="${String(itemId).replace(/"/g, "\\\"")}"]`).first();
  if (await card.count() === 1) return card;
  const tabs = page.locator(".store-category-tab");
  const tabCount = await tabs.count();
  for (let index = 0; index < tabCount; index += 1) {
    await tabs.nth(index).click();
    await page.waitForTimeout(80);
    card = page.locator(`[data-store-item-id="${String(itemId).replace(/"/g, "\\\"")}"]`).first();
    if (await card.count() === 1) return card;
  }
  return card;
}

async function getLiveStoreState(page) {
  const state = await page.evaluate(async () => {
    const client = window.CheckmateQuestSupabaseClient?.client;
    const result = await client?.rpc?.("get_store_state");
    const value = Array.isArray(result?.data) ? result.data[0] : result?.data;
    return {
      error: result?.error?.message || "",
      catalog: Array.isArray(value?.catalog) ? value.catalog : [],
      inventory: Array.isArray(value?.inventory) ? value.inventory : []
    };
  });
  assert(!state.error, `Store state RPC failed while selecting an E2E item: ${state.error}`);
  return state;
}

async function readStorePurchaseSettlementDiagnostics(page, itemId, runtimeTrace = {}) {
  const dom = await page.evaluate(async (id) => {
    const card = [...document.querySelectorAll("[data-store-item-id]")].find((element) => element.dataset.storeItemId === id);
    const action = card?.querySelector("[data-store-item-action]");
    const status = document.getElementById("storeStatus");
    const client = window.CheckmateQuestSupabaseClient?.client;
    let session = { present: false, userId: "", error: "" };
    try {
      const result = await client?.auth?.getSession?.();
      const userId = String(result?.data?.session?.user?.id || "");
      session = {
        present: Boolean(userId),
        userId: userId ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : "",
        error: result?.error?.message || ""
      };
    } catch (error) {
      session.error = String(error?.message || error || "unknown");
    }
    return {
      url: location.href,
      hash: location.hash,
      authState: document.documentElement.dataset.authState || "",
      storeSyncStatus: document.documentElement.dataset.storeSyncStatus || "",
      session,
      card: card ? {
        exists: true,
        className: card.className,
        ariaBusy: card.getAttribute("aria-busy"),
        owned: card.classList.contains("is-owned"),
        equipped: card.classList.contains("is-equipped"),
        pending: card.classList.contains("is-pending")
      } : { exists: false },
      action: action ? {
        text: String(action.textContent || "").trim(),
        disabled: Boolean(action.disabled),
        ariaBusy: action.getAttribute("aria-busy"),
        pending: action.classList.contains("is-pending")
      } : { exists: false },
      status: status ? {
        text: String(status.textContent || "").trim(),
        ariaBusy: status.getAttribute("aria-busy"),
        pendingItem: status.dataset.storePendingItem || "",
        diagnostic: status.dataset.purchaseDiagnostic || status.dataset.storePurchaseDiagnostic || ""
      } : { exists: false }
    };
  }, itemId).catch((error) => ({ evaluationError: redactDiagnosticText(error?.message || error) }));
  return {
    dom,
    consoleErrors: (runtimeTrace.consoleErrors || []).slice(-8),
    pageErrors: (runtimeTrace.pageErrors || []).slice(-8),
    requestFailures: (runtimeTrace.requestFailures || []).slice(-8)
  };
}

async function waitForStorePurchaseSettlement(page, itemId, runtimeTrace) {
  // A successfully purchased item is equipped immediately.  Its final action
  // must therefore be deliberately disabled as "Equipped", not re-enabled.
  // This proves the transaction lock cleared without mistaking the correct
  // post-equip disabled button for a stuck pending request.
  try {
    await page.waitForFunction((id) => {
      const card = [...document.querySelectorAll("[data-store-item-id]")].find((element) => element.dataset.storeItemId === id);
      const action = card?.querySelector("[data-store-item-action]");
      const status = document.getElementById("storeStatus");
      return Boolean(
        card
        && card.classList.contains("is-owned")
        && card.classList.contains("is-equipped")
        && !card.classList.contains("is-pending")
        && card.getAttribute("aria-busy") !== "true"
        && action
        && action.disabled
        && !action.classList.contains("is-pending")
        && action.getAttribute("aria-busy") !== "true"
        && /equipped/i.test(action.textContent || "")
        && status?.dataset.storePendingItem !== id
        && status?.getAttribute("aria-busy") !== "true"
      );
    }, itemId, { timeout: 15000 });
  } catch (error) {
    const diagnostics = await readStorePurchaseSettlementDiagnostics(page, itemId, runtimeTrace);
    throw new Error(`Store purchase ${itemId} did not settle into its owned/equipped, non-pending state: ${JSON.stringify({ timeout: error.message, diagnostics })}`);
  }
}

function selectE2eStoreItem(state, preferredId = "", excludedIds = []) {
  const excluded = new Set(excludedIds.map((id) => String(id || "")));
  const owned = new Set((state.inventory || []).map((item) => String(item.item_id || item.itemId || "")));
  const purchasable = (state.catalog || []).filter((item) => {
    const id = String(item.item_id || item.itemId || "");
    return id
      && !owned.has(id)
      && !excluded.has(id)
      && String(item.unlock_method || item.unlockMethod || "").toLowerCase() === "coins"
      && Number(item.cost_coins || item.cost || 0) > 0
      && item.active !== false;
  });
  const preferred = purchasable.find((item) => String(item.item_id || item.itemId || "") === String(preferredId || ""));
  // Keep normal regression runs low-impact and avoid cosmetics that would
  // alter the identity assertions already performed earlier in the suite.
  const lowerImpactTypes = new Set(["lastMove", "trail", "boardBorder", "backgroundTheme", "avatarEffect"]);
  const fallback = purchasable
    .filter((item) => lowerImpactTypes.has(String(item.item_type || item.itemType || "")))
    .sort((left, right) => Number(left.cost_coins || left.cost || 0) - Number(right.cost_coins || right.cost || 0))[0]
    || purchasable.sort((left, right) => Number(left.cost_coins || left.cost || 0) - Number(right.cost_coins || right.cost || 0))[0];
  return preferred || fallback || null;
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
  await waitForAuthenticatedHydration(page, "primary");
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
    await waitForAuthenticatedHydration(page, `primary ${hash}`);
    await waitForStoreHydration(page, `primary ${hash}`);
    await auditIdentity(page, `authenticated${hash}`, expectedStyle);
  }
  pass("browser: equipped Name Style pipeline across mounted modes");

  if (secondState) {
    const secondContext = await browser.newContext({ storageState: secondState, viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
    const secondPage = await secondContext.newPage();
    await gotoHash(secondPage, baseUrl, "#login");
    await waitForAuthenticatedHydration(secondPage, "secondary");
    await waitForStoreHydration(secondPage, "secondary");
    const secondExpectedStyle = String(process.env.E2E_SECOND_EXPECTED_NAME_STYLE || "").trim();
    await auditIdentity(secondPage, "second-account mobile identity", secondExpectedStyle);
    if (expectedStyle && secondExpectedStyle) assert(expectedStyle !== secondExpectedStyle, "The two dedicated accounts must use distinct expected Name Styles for identity isolation coverage.");
    await secondContext.close();
    pass("browser: second dedicated account identity isolation");
  } else pass("browser: second-account identity isolation not configured (optional dedicated account)");

  let purchaseId = String(process.env.E2E_PURCHASE_ITEM_ID || "").trim();
  let purchasePrice = Number(process.env.E2E_PURCHASE_ITEM_PRICE || 0);
  {
    await gotoHash(page, baseUrl, "#store");
    const selectedPurchase = selectE2eStoreItem(await getLiveStoreState(page), purchaseId);
    assert(selectedPurchase, "No unowned coin-purchasable Store item is available for the dedicated E2E account.");
    purchaseId = String(selectedPurchase.item_id || selectedPurchase.itemId || "");
    purchasePrice = Number(selectedPurchase.cost_coins || selectedPurchase.cost || 0);
    let card = await findStoreItemCard(page, purchaseId);
    assert(await card.count() === 1, `selected Store item ${purchaseId} is not rendered.`);
    const action = card.locator("[data-store-item-action]").first();
    assert(!(await card.evaluate((element) => element.classList.contains("is-owned")).catch(() => false)), `selected E2E purchase item ${purchaseId} is already owned.`);
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
      const purchaseRuntimeTrace = { consoleErrors: [], pageErrors: [], requestFailures: [] };
      page.on("console", (message) => {
        if (message.type() === "error") purchaseRuntimeTrace.consoleErrors.push(redactDiagnosticText(message.text()));
      });
      page.on("pageerror", (error) => purchaseRuntimeTrace.pageErrors.push(redactDiagnosticText(error?.message || error)));
      page.on("requestfailed", (request) => purchaseRuntimeTrace.requestFailures.push({
        url: redactTraceUrl(request.url()),
        failure: redactDiagnosticText(request.failure()?.errorText || "unknown")
      }));
      const requestUrls = [];
      const rpcRequests = [];
      page.on("request", (request) => {
        if (!/purchase_cosmetic/.test(request.url())) return;
        requestUrls.push(request.url());
        let payload = null;
        try { payload = request.postDataJSON(); } catch {}
        rpcRequests.push(payload);
      });
      const purchaseResponse = page.waitForResponse((response) => /purchase_cosmetic/.test(response.url()), { timeout: 15000 });
      await action.click();
      const pendingSeen = await action.evaluate((element) => element.disabled || element.classList.contains("is-pending") || element.closest(".store-card")?.classList.contains("is-pending")).catch(() => false);
      // Deliberately bypass the native disabled state for the second event;
      // the app-level action lock must still keep the RPC count at one.
      await action.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).catch(() => {});
      assert(pendingSeen || requestUrls.length > 0, "Store Buy did not show a pending state or issue a purchase request promptly.");
      const purchaseResponseValue = await purchaseResponse;
      let purchaseResponseBody = null;
      try { purchaseResponseBody = await purchaseResponseValue.json(); } catch {}
      assert(requestUrls.length === 1, `authenticated Store purchase should issue exactly one RPC request; saw ${requestUrls.length}.`);
      assert(rpcRequests[0]?.p_item_id === purchaseId && String(rpcRequests[0]?.p_idempotency_key || "").length >= 8, "purchase_cosmetic received an invalid item or idempotency payload.");
      assert(purchaseResponseValue.status() >= 200 && purchaseResponseValue.status() < 300, `purchase_cosmetic did not return success: ${JSON.stringify({ status: purchaseResponseValue.status(), body: purchaseResponseBody })}`);
      // An RPC response is the end of the database transaction, not the end
      // of the client flow: the application still refreshes the authoritative
      // inventory and equips the item.  Assert that actual settled UI state
      // before reading it, never with a wall-clock delay.
      await waitForStorePurchaseSettlement(page, purchaseId, purchaseRuntimeTrace);
      const statusDiagnostic = await page.locator("#storeStatus").getAttribute("data-purchase-diagnostic").catch(() => "");
      assert(statusDiagnostic !== "LOCAL_FALLBACK", "Authenticated Store test used the local/guest wallet path.");
      const statusText = await page.locator("#storeStatus").textContent().catch(() => "");
      assert(!/failed|rejected|could not|error/i.test(statusText), `Store purchase returned an error: ${statusText}`);
      const owned = await card.evaluate((element) => element.classList.contains("is-owned") || /owned|equipped/i.test(element.textContent || ""));
      assert(owned, `Store item ${purchaseId} did not become owned after purchase.`);
      const afterText = await page.locator("#storeCoinBalance").textContent();
      assert(beforeText !== afterText, `Store balance did not update after purchasing ${purchaseId}.`);
      if (purchasePrice > 0) {
        const before = Number(String(beforeText).replace(/[^0-9.-]/g, ""));
        const after = Number(String(afterText).replace(/[^0-9.-]/g, ""));
        assert(before - after === purchasePrice, `Store wallet delta was ${before - after}; expected ${purchasePrice}.`);
        const rpcBody = Array.isArray(purchaseResponseBody) ? purchaseResponseBody[0] : purchaseResponseBody;
        assert(Number(rpcBody?.coins) === after, `Store UI balance ${after} did not match the RPC server balance.`);
      }
      const rpcResult = Array.isArray(purchaseResponseBody) ? purchaseResponseBody[0] : purchaseResponseBody;
      console.log(`[e2e purchase proof] ${JSON.stringify({
        itemId: purchaseId,
        balanceBefore: Number(String(beforeText).replace(/[^0-9.-]/g, "")),
        price: purchasePrice,
        balanceAfter: Number(String(afterText).replace(/[^0-9.-]/g, "")),
        rpcStatus: purchaseResponseValue.status(),
        rpcCoins: Number(rpcResult?.coins),
        rpcCalls: requestUrls.length,
        localFallback: false,
        owned: true
      })}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await gotoHash(page, baseUrl, "#store");
      await waitForAuthHydration(page, "Store refresh auth");
      await waitForStoreHydration(page, "Store refresh state");
      let refreshedCard = await findStoreItemCard(page, purchaseId);
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
        await page.waitForFunction((id) => {
          const card = document.querySelector(`[data-store-item-id="${CSS.escape(id)}"]`);
          return Boolean(card?.classList.contains("is-equipped") || /equipped/i.test(card?.textContent || ""));
        }, purchaseId, { timeout: 15000 }).catch(() => {});
        page.off("request", onEquipRequest);
        page.off("response", onEquipResponse);
        if (!(await refreshedCard.evaluate((element) => element.classList.contains("is-equipped") || /equipped/i.test(element.textContent || "")))) {
          const statusAfterEquip = await page.locator("#storeStatus").textContent().catch(() => "");
          throw new Error(`Store item ${purchaseId} could not be equipped after refresh. status=${statusAfterEquip}; equipRequests=${JSON.stringify(equipRequests)}; equipResponses=${JSON.stringify(equipResponses)}`);
        }
      }
      pass(`browser: authenticated Store purchase, pending state, ownership, and wallet update (${purchaseId})`);
  }

  await gotoHash(page, baseUrl, "#store");
  // A normal run purchases one disposable item above.  Choose a different
  // unowned item here for the intentionally failed RPC instead of allowing a
  // stale env ID to turn a required regression into a skip after a few runs.
  let failureId = String(process.env.E2E_FAILURE_ITEM_ID || "").trim();
  const selectedFailure = selectE2eStoreItem(await getLiveStoreState(page), failureId, [purchaseId]);
  assert(selectedFailure, "No second unowned coin-purchasable Store item is available for the E2E failure-path test.");
  failureId = String(selectedFailure.item_id || selectedFailure.itemId || "");
  const failureCard = await findStoreItemCard(page, failureId);
  assert(await failureCard.count() === 1, `selected Store failure item ${failureId} is not rendered.`);
  assert(!(await failureCard.evaluate((element) => element.classList.contains("is-owned")).catch(() => false)), `selected failure item ${failureId} is already owned.`);
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

  const logoutContext = await browser.newContext({ storageState: primaryState, viewport: { width: 1024, height: 800 }, serviceWorkers: "allow" });
  const logoutPage = await logoutContext.newPage();
  await gotoHash(logoutPage, baseUrl, "#login");
  await logoutPage.locator("#authPanelLogout").click();
  await logoutPage.waitForFunction(() => document.documentElement.dataset.authState !== "authenticated", null, { timeout: 10000 });
  pass("browser: logout clears the authenticated session");
  await logoutContext.close();
  await context.close();
}

async function runDeepAuthenticatedQa(browser, baseUrl, primaryState) {
  if (!primaryState) {
    skip("browser: deep authenticated QA", "dedicated E2E credentials are not configured");
    return;
  }
  const routes = [
    ["home", "#top"], ["profile", "#login"], ["play", "#play"], ["bots", "#bots"],
    ["puzzles", "#puzzles"], ["learn", "#tutorial"], ["videos", "#videos"],
    ["friends", "#friends"], ["history", "#history"], ["leaderboards", "#leaderboards"], ["tournaments", "#play?mode=tournament"],
    ["openings", "#openings"], ["review", "#gameReview"], ["store", "#store"]
  ];
  const expectedStyle = String(process.env.E2E_EXPECTED_NAME_STYLE || "").trim();
  const viewports = [[1366, 900], [1024, 800], [768, 900], [390, 844]];
  for (const [width, height] of viewports) {
    const context = await browser.newContext({ storageState: primaryState, viewport: { width, height }, serviceWorkers: "allow" });
    const page = await context.newPage();
    for (const [label, hash] of routes) {
      await gotoHash(page, baseUrl, hash);
      await waitForAuthenticatedHydration(page, `deep ${label}@${width}`);
      await waitForStoreHydration(page, `deep ${label}@${width}`);
      const state = await readIdentityVisualState(page);
      assertIdentityVisualConsistency(state, `deep ${label}@${width}`, expectedStyle);
    }
    await context.close();
    pass(`browser: deep identity route audit @ ${width}px (${routes.length} routes)`);
  }

  const context = await browser.newContext({ storageState: primaryState, viewport: { width: 1366, height: 900 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  await gotoHash(page, baseUrl, "#store");
  await waitForAuthHydration(page, "deep store");
  await waitForStoreHydration(page, "deep store");
  const storeState = await page.evaluate(async () => {
    const client = window.CheckmateQuestSupabaseClient?.client;
    const result = await client?.rpc?.("get_store_state");
    const value = Array.isArray(result?.data) ? result.data[0] : result?.data;
    return { error: result?.error?.message || "", catalog: Array.isArray(value?.catalog) ? value.catalog : [], inventory: Array.isArray(value?.inventory) ? value.inventory : [] };
  });
  assert(!storeState.error, `deep Store state RPC failed: ${storeState.error}`);
  const catalogCounts = new Map();
  storeState.catalog.forEach((item) => { const id = String(item.item_id || item.itemId || ""); catalogCounts.set(id, (catalogCounts.get(id) || 0) + 1); });
  const duplicateCatalogIds = [...catalogCounts.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id}×${count}`);
  const expectedCatalog = JSON.parse(fs.readFileSync(path.join(root, "supabase", "store-catalog.json"), "utf8"));
  const expectedCatalogIds = new Set(expectedCatalog.map((item) => String(item.item_id || item.itemId || "")));
  const liveCatalogIds = new Set(storeState.catalog.map((item) => String(item.item_id || item.itemId || "")));
  const extraCatalogIds = [...liveCatalogIds].filter((id) => !expectedCatalogIds.has(id));
  const missingCatalogIds = [...expectedCatalogIds].filter((id) => !liveCatalogIds.has(id));
  assert(storeState.catalog.length >= expectedCatalog.length, `deep Store catalog is smaller than the checked-in catalog (${storeState.catalog.length}/${expectedCatalog.length}); duplicates=${duplicateCatalogIds.join(",")}; extra=${extraCatalogIds.join(",")}; missing=${missingCatalogIds.join(",")}`);
  assert(missingCatalogIds.length === 0, `deep Store catalog is missing expected IDs: ${missingCatalogIds.join(",")}`);
  const ownedIds = new Set(storeState.inventory.map((item) => String(item.itemId || item.item_id || "")));
  const tabCount = await page.locator(".store-category-tab").count();
  const visibleIds = new Set();
  for (let index = 0; index < tabCount; index += 1) {
    const tab = page.locator(".store-category-tab").nth(index);
    await tab.click();
    await page.waitForTimeout(90);
    (await page.locator(".store-card[data-store-item-id]").evaluateAll((cards) => cards.map((card) => card.dataset.storeItemId))).forEach((id) => visibleIds.add(id));
  }
  const missingUiIds = expectedCatalog.map((item) => String(item.item_id || item.itemId || "")).filter((id) => !visibleIds.has(id));
  assert(missingUiIds.length === 0, `deep Store UI is missing catalog items: ${missingUiIds.slice(0, 12).join(", ")}${missingUiIds.length > 12 ? "…" : ""}`);
  const byType = new Map();
  expectedCatalog.forEach((item) => { if (!byType.has(item.item_type)) byType.set(item.item_type, item); });
  for (const [type, item] of byType) {
    let card = page.locator(`[data-store-item-id="${String(item.item_id).replace(/"/g, "\\\"")}"]`).first();
    if (await card.count() !== 1) {
      for (let index = 0; index < tabCount && await card.count() !== 1; index += 1) {
        await page.locator(".store-category-tab").nth(index).click();
        await page.waitForTimeout(70);
        card = page.locator(`[data-store-item-id="${String(item.item_id).replace(/"/g, "\\\"")}"]`).first();
      }
    }
    assert(await card.count() === 1, `deep Store representative ${type} (${item.item_id}) is not rendered.`);
    assert(await card.locator(".store-preview").count() === 1, `deep Store representative ${type} has no renderer preview.`);
    assert(await card.locator("[data-store-item-action]").count() === 1, `deep Store representative ${type} has no action.`);
  }
  pass(`browser: Store catalog UI audit (${expectedCatalog.length}/${storeState.catalog.length} expected IDs; ${extraCatalogIds.length} server-only row${extraCatalogIds.length === 1 ? "" : "s"}, ${byType.size} cosmetic types)`);

  await page.locator(".store-category-tab").filter({ hasText: "Name Styles" }).click();
  await page.waitForTimeout(120);
  const nameCards = page.locator('.store-card[data-store-item-id^="name-"]');
  assert(await nameCards.count() >= 2, "deep Name Style Store category did not render at least two styles.");
  for (const card of await nameCards.all()) {
    const preview = card.locator(".store-preview-name-style");
    assert(await preview.count() === 1 && await preview.isVisible(), "deep Name Style preview is missing or hidden.");
    const previewText = await preview.textContent();
    assert(String(previewText || "").trim().length > 0, "deep Name Style preview has no visible text.");
  }
  pass(`browser: all visible Name Style previews use the shared text renderer (${await nameCards.count()})`);

  const ownedNameIds = storeState.inventory.map((item) => String(item.itemId || item.item_id || "")).filter((id) => id.startsWith("name-"));
  const switchIds = [...new Set(["name-classic", ...ownedNameIds])].slice(0, 2);
  if (switchIds.length >= 2) {
    const first = switchIds[0];
    const second = switchIds[1];
    const equipNameStyle = async (itemId) => {
      await page.locator(`[data-store-item-id="${itemId}"] [data-store-item-action]`).click();
      await page.waitForFunction((style) => [...document.querySelectorAll('.player-identity-line[data-identity-owner="player"]')].some((line) => line.dataset.identityNameStyle === style), itemId.replace(/^name-/, ""), { timeout: 10000 }).catch(() => {});
    };
    await equipNameStyle(first);
    const firstStyle = first.replace(/^name-/, "");
    assertIdentityVisualConsistency(await readIdentityVisualState(page), `deep mounted Name Style ${firstStyle}`, firstStyle);
    await equipNameStyle(second);
    const secondStyle = second.replace(/^name-/, "");
    assertIdentityVisualConsistency(await readIdentityVisualState(page), `deep mounted Name Style ${secondStyle}`, secondStyle);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAuthHydration(page, "deep Name Style refresh");
    await waitForStoreHydration(page, "deep Name Style refresh");
    assertIdentityVisualConsistency(await readIdentityVisualState(page), "deep Name Style refresh persistence", secondStyle);
    if (second !== "name-sky" && ownedNameIds.includes("name-sky")) {
      await page.locator('.store-category-tab').filter({ hasText: "Name Styles" }).click();
      await page.waitForTimeout(100);
      await page.locator('[data-store-item-id="name-sky"] [data-store-item-action]').click();
      await page.waitForTimeout(500);
    }
    pass(`browser: mounted Name Style switch, computed tokens, and refresh persistence (${firstStyle} → ${secondStyle})`);
  } else skip("browser: mounted Name Style switch", "the disposable account does not own two Name Styles");

  await gotoHash(page, baseUrl, "#store");
  await waitForAuthHydration(page, "deep Store scroll");
  await waitForStoreHydration(page, "deep Store scroll");
  // Route activation refreshes the authenticated wallet and gift inbox. Let
  // those deliberate, one-shot requests finish before measuring the scroll
  // listener, which must be network-free on an already-hydrated Store.
  await page.waitForTimeout(900);
  const scrollNetworkRequests = [];
  const onScrollRequest = (request) => {
    if (/supabase|rest\/v1|rpc\//i.test(request.url())) scrollNetworkRequests.push(redactTraceUrl(request.url()));
  };
  page.on("request", onScrollRequest);
  const scrollAudit = await page.evaluate(async () => {
    const grid = document.getElementById("storeGrid");
    if (!grid) return { mutations: -1, requests: -1 };
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.reduce((sum, record) => sum + record.addedNodes.length + record.removedNodes.length, 0); });
    observer.observe(grid, { childList: true, subtree: true });
    for (let index = 0; index < 8; index += 1) window.scrollTo(0, index * 420);
    await new Promise((resolve) => setTimeout(resolve, 250));
    observer.disconnect();
    return { mutations };
  });
  page.off("request", onScrollRequest);
  assert(scrollAudit.mutations === 0, `Store scrolling mutated ${scrollAudit.mutations} DOM nodes.`);
  assert(scrollNetworkRequests.length === 0, `Store scrolling issued ${scrollNetworkRequests.length} network requests: ${scrollNetworkRequests.join(", ")}`);
  pass("browser: Store scrolling causes no catalog rebuild or network churn");
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
    await runOAuthButtonTests(browser, baseUrl);
    const primaryState = await prepareAuth(browser, baseUrl, process.env.E2E_EMAIL, process.env.E2E_PASSWORD, "primary");
    const secondState = await prepareAuth(browser, baseUrl, process.env.E2E_SECOND_EMAIL, process.env.E2E_SECOND_PASSWORD, "secondary");
    await runGuestBrowserTests(browser, baseUrl, [[1366, 900], [1024, 800], [768, 900], [390, 844]]);
    // Run the deep route/Store audit before the focused authenticated suite's
    // logout check.  The logout test intentionally invalidates the disposable
    // session server-side; reusing that state afterward would turn the deep
    // audit into a Guest Explorer run even though the account setup is valid.
    await runDeepAuthenticatedQa(browser, baseUrl, primaryState);
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
