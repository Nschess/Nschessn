const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const origin = "https://nschessn.vercel.app";
const publicPaths = ["/", "/learn-chess/", "/chess-puzzles/", "/play-chess/", "/game-review/", "/daily-chess-practice/"];
const pageSpecs = [
  { path: "/learn-chess/", action: "/#tutorial", title: "Learn Chess Fundamentals with Guided Lessons | Nschess", h1: "Learn chess fundamentals one move at a time", text: /68 guided board exercises/ },
  { path: "/chess-puzzles/", action: "/#puzzles", title: "Chess Puzzles and Tactical Practice | Nschess", h1: "Practice chess tactics with clear goals", text: /Daily grants no XP, coins, ratings, or synced account rewards/ },
  { path: "/play-chess/", action: "/#bots", title: "Play Chess Against a Computer or Friend | Nschess", h1: "Play chess against a computer or challenge a friend", text: /not independently calibrated Elo ratings/ },
  { path: "/game-review/", action: "/#game-review", title: "Chess Game Review and Learning | Nschess", h1: "Review chess moves and learn from a completed game", text: /does not change a match result, rating, XP, or reward/ },
  { path: "/daily-chess-practice/", action: "/#plan", title: "A Practical Daily Chess Practice Routine | Nschess", h1: "Build a practical daily chess routine", text: /not synced, are not a verified account record/ }
];
const mime = new Map([[".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".xml", "application/xml; charset=utf-8"], [".svg", "image/svg+xml"]]);

function load(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function htmlPath(urlPath, siteRoot = root) {
  const decoded = decodeURIComponent(urlPath);
  const target = path.resolve(siteRoot, `.${decoded}`);
  assert.ok(target === siteRoot || target.startsWith(`${siteRoot}${path.sep}`), `request cannot escape site root: ${urlPath}`);
  const stat = fs.statSync(target);
  return stat.isDirectory() ? path.join(target, "index.html") : target;
}
function startServer(siteRoot = root) {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname); }
    catch { response.writeHead(400).end(); return; }
    if (pathname === "/") pathname = "/index.html";
    if (pathname.endsWith("/")) pathname += "index.html";
    let file;
    try { file = htmlPath(pathname, siteRoot); }
    catch { response.writeHead(404).end("Not found"); return; }
    fs.readFile(file, (error, body) => {
      if (error) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": mime.get(path.extname(file)) || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server); });
  });
}

function validateStaticContracts() {
  const sitemap = load("sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">[\s\S]*<\/urlset>\s*$/);
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, publicPaths.map((pathname) => `${origin}${pathname}`), "sitemap contains exactly the homepage and canonical public guides, in deterministic order");
  assert.equal(new Set(locations).size, locations.length, "sitemap URLs are unique");
  assert.ok(locations.every((url) => !url.includes("#") && !url.includes("/api/") && !url.includes("/outputs/")), "no fragments or API/auth-only URLs are submitted for indexing");
  const robots = load("robots.txt");
  assert.match(robots, /^User-agent: \*\s+Allow: \/\s+Disallow: \/api\/\s+\s*Sitemap: https:\/\/nschessn\.vercel\.app\/sitemap\.xml\s*$/);
  for (const pathname of publicPaths.slice(1)) assert.ok(!robots.includes(`Disallow: ${pathname}`), `public guide remains crawlable: ${pathname}`);

  const homepage = load("index.html");
  assert.match(homepage, /<title>Nschess — Chess Lessons, Puzzles &amp; Practice<\/title>/);
  assert.match(homepage, /<link rel="canonical" href="https:\/\/nschessn\.vercel\.app\/"\s*\/>/);
  for (const pathname of publicPaths.slice(1)) assert.ok(homepage.includes(`href="${pathname}"`), `homepage footer links to ${pathname}`);
  assert.match(homepage, /<meta name="robots" content="index, follow"\s*\/>/i);

  const pageTitles = new Set();
  const pageDescriptions = new Set();
  for (const spec of pageSpecs) {
    const html = load(`${spec.path.slice(1)}index.html`);
    assert.match(html, /<meta name="robots" content="index,follow"\s*\/>/);
    assert.match(html, new RegExp(`<title>${spec.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/title>`));
    assert.match(html, new RegExp(`<h1>${spec.h1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/h1>`));
    assert.match(html, /<meta name="description" content="[^"]+"\s*\/>/);
    assert.equal(html.match(/<link rel="canonical" href="([^"]+)"\s*\/>/)?.[1], `${origin}${spec.path}`, `${spec.path} has its own exact canonical`);
    assert.match(html, /<meta property="og:title" content="[^"]+"\s*\/>/);
    assert.match(html, /<meta property="og:description" content="[^"]+"\s*\/>/);
    assert.equal(html.match(/<meta property="og:url" content="([^"]+)"\s*\/>/)?.[1], `${origin}${spec.path}`, `${spec.path} has its own exact social URL`);
    assert.match(html, /<meta name="twitter:title" content="[^"]+"\s*\/>/);
    assert.match(html, /<meta name="twitter:description" content="[^"]+"\s*\/>/);
    assert.match(html, spec.text);
    assert.doesNotMatch(html, /<script\b/i, "crawlable guides do not require JavaScript or load the application bundle");
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    const description = html.match(/<meta name="description" content="([^"]+)"\s*\/>/)[1];
    assert.ok(!pageTitles.has(title), `page title is unique: ${spec.path}`);
    assert.ok(!pageDescriptions.has(description), `page description is unique: ${spec.path}`);
    pageTitles.add(title);
    pageDescriptions.add(description);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(links.includes("/"), `${spec.path} links home`);
    assert.equal(html.match(/class="guide-cta" href="([^"]+)"/)?.[1], spec.action, `${spec.path} opens its actual application route`);
    assert.ok(links.every((href) => !/^https?:\/\/(?!nschessn\.vercel\.app)/i.test(href)), `${spec.path} has no unreviewed external link`);
    for (const href of links.filter((link) => !link.startsWith("#") && !link.startsWith("/#") && !/^https?:/.test(link))) {
      const target = new URL(href, `${origin}${spec.path}`);
      assert.ok(fs.existsSync(htmlPath(target.pathname)), `${spec.path} internal link exists: ${href}`);
    }
  }
  const guideCss = load("assets/public-guides.css");
  assert.ok(Buffer.byteLength(guideCss) < 8000, "standalone guide stylesheet stays under 8 KB");
  const buildScript = load("scripts/build-pages.js");
  for (const entry of ["learn-chess", "chess-puzzles", "play-chess", "game-review", "daily-chess-practice", "sitemap.xml"]) {
    assert.ok(buildScript.includes(`"${entry}"`), `production static build includes ${entry}`);
  }
}

async function testNoJavaScriptPages() {
  const { chromium } = require("playwright");
  const builtRoot = path.join(root, "dist");
  const siteRoot = fs.existsSync(builtRoot) ? builtRoot : root;
  const server = await startServer(siteRoot);
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const windowsChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const executablePath = process.env.CHROME_PATH || (process.platform === "win32" && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
    browser = await chromium.launch({ headless: true, executablePath, timeout: 20000 });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, javaScriptEnabled: false, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.route("**/*", (route) => new URL(route.request().url()).origin === base
      ? route.continue()
      : route.abort());
    const observed = [];
    for (const spec of pageSpecs) {
      const response = await page.goto(`${base}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 15000 });
      assert.equal(response.status(), 200, `${spec.path} direct request succeeds`);
      const crawler = await context.request.get(`${base}${spec.path}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
      assert.equal(crawler.status(), 200, `${spec.path} crawler-style direct request succeeds`);
      assert.match(crawler.headers()["content-type"], /text\/html/);
      assert.equal(await crawler.text(), await response.text(), `${spec.path} delivers the same HTML to visitors and crawler-style requests`);
      assert.equal(await page.title(), spec.title);
      assert.equal(await page.locator("h1").innerText(), spec.h1);
      assert.equal(await page.locator('link[rel="canonical"]').count(), 1);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), `${origin}${spec.path}`);
      assert.equal(await page.locator(".guide-cta").getAttribute("href"), spec.action);
      assert.equal(await page.locator("script").count(), 0, `${spec.path} stays readable with JavaScript disabled`);
      assert.ok((await page.locator("main").innerText()).length > 250, `${spec.path} has substantive server-delivered body content`);
      assert.equal(await page.locator(".guide-skip-link").count(), 1, `${spec.path} has a keyboard skip link`);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.className), "guide-skip-link", `${spec.path} skip link receives the first keyboard focus`);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.className), "guide-brand", `${spec.path} brand link follows the skip link in keyboard order`);
      for (const width of [1366, 390, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          navTargets: [...document.querySelectorAll(".guide-nav a")].map((link) => Math.round(link.getBoundingClientRect().height)),
          ctaHeight: Math.round(document.querySelector(".guide-cta").getBoundingClientRect().height),
          mainWidth: Math.round(document.querySelector(".guide-main").getBoundingClientRect().width) }));
        assert.ok(layout.scrollWidth <= width + 1, `${spec.path} has no horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.navTargets.every((height) => height >= 44), `${spec.path} has comfortable navigation targets at ${width}px`);
        assert.ok(layout.ctaHeight >= 44, `${spec.path} primary link is comfortably tappable at ${width}px`);
        observed.push({ path: spec.path, ...layout });
        if (process.env.PHASE12_SCREENSHOT_DIR && spec.path === "/chess-puzzles/" && [1366, 320].includes(width)) {
          fs.mkdirSync(process.env.PHASE12_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.PHASE12_SCREENSHOT_DIR, `phase12-puzzles-${width}.png`), fullPage: false });
        }
      }
    }

    const homeResponse = await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    assert.equal(homeResponse.status(), 200, "homepage direct request succeeds");
    assert.equal(await page.title(), "Nschess — Chess Lessons, Puzzles & Practice");
    assert.equal(await page.locator("h1").innerText(), "Make your next move count.", "homepage content is delivered without JavaScript");
    assert.ok(await page.locator('a[href="/daily-chess-practice/"]').count() > 0, "Study Plan guide is discoverable from the homepage footer without JavaScript");
    for (const width of [1366, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= width + 1, `homepage footer guide links do not introduce overflow at ${width}px`);
      observed.push({ path: "/", ...layout });
      if (process.env.PHASE12_SCREENSHOT_DIR && width === 390) {
        fs.mkdirSync(process.env.PHASE12_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PHASE12_SCREENSHOT_DIR, "phase12-home-390.png"), fullPage: false });
      }
    }
    if (process.env.PHASE12_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.locator(".footer-links").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.PHASE12_SCREENSHOT_DIR, "phase12-home-footer-390.png"), fullPage: false });
    }
    await context.close();
    return observed;
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyBuildArtifact() {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist)) return "NOT RUN (build artifact not present)";
  const entries = [...pageSpecs.map((spec) => `${spec.path.slice(1)}index.html`), "index.html", "assets/public-guides.css", "sitemap.xml", "robots.txt"];
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(dist, entry)), `built artifact includes ${entry}`);
    assert.deepEqual(fs.readFileSync(path.join(dist, entry)), fs.readFileSync(path.join(root, entry)), `built ${entry} matches the candidate source`);
  }
  return "PASS";
}

async function main() {
  validateStaticContracts();
  const buildArtifact = await verifyBuildArtifact();
  const browser = await testNoJavaScriptPages();
  process.stdout.write(`${JSON.stringify({ result: "PASS", sitemapUrls: publicPaths.map((pathname) => `${origin}${pathname}`), buildArtifact, crawlerResponses: "PASS", noJavaScriptBrowser: browser }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL SEO regression: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
