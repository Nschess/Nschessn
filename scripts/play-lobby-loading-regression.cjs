const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { installOfflineSupabaseFixture, installOptionalCdnFixtures } = require('./e2e-runtime-fixtures.cjs');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
async function main() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const holdStyles of [true, false]) for (const width of [768, 320, 390, 1024, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      await installOfflineSupabaseFixture(context);
      await installOptionalCdnFixtures(context);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let moduleRequested;
      const requested = new Promise(resolve => { moduleRequested = resolve; });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/auth-config') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supabaseUrl: '', supabaseAnonKey: '' }) });
        if (url.pathname === '/assets/routes/play.js') { moduleRequested(); await gate; }
        if (holdStyles && url.pathname === '/assets/play-lobby.css') await gate;
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${origin}/#play`, { waitUntil: 'domcontentloaded' });
        let requestTimeout;
        await Promise.race([requested, new Promise((_, reject) => {
          requestTimeout = setTimeout(() => reject(new Error("Play module was not requested within 15 seconds.")), 15000);
        })]).finally(() => clearTimeout(requestTimeout));
        if (holdStyles) await page.waitForTimeout(500);
        else await page.waitForFunction(() => [...document.querySelectorAll('link[data-route-style]')].some(link => link.dataset.routeStyle === 'play-lobby' && link.sheet), null, { timeout: 10000 });
        const before = await page.evaluate(() => {
          const board = document.getElementById('coachBoard');
          const rect = board.getBoundingClientRect();
          const entry = document.getElementById('humanPlayEntry').getBoundingClientRect();
          return { route: location.hash, classes: document.getElementById('play').className, squares: board.querySelectorAll('[data-square]').length, width: rect.width, height: rect.height, entryVisible: entry.width > 0 && entry.height > 0, shellDisplay: getComputedStyle(document.getElementById('playWorkspace')).display };
        });
        console.log(`pre-initialization@${width} (stylesheet delayed: ${holdStyles}): ${JSON.stringify(before)}`);
        // A visible board must always meet the existing 64-square audit. The
        // human lobby must not expose an uninitialized game workspace at all.
        if (before.width > 0 && before.height > 0) assert.equal(before.squares, 64, `play@${width}/coachBoard: expected 64 squares, found ${before.squares}.`);
        assert(before.entryVisible, 'Human entry must be usable while the module is delayed.');
        assert.equal(before.width, 0, 'Pre-game Play must keep the game workspace hidden.');
        release();
        await page.waitForFunction(() => document.getElementById('play').classList.contains('play-lobby'), null, { timeout: 15000 });
        assert.equal(await page.locator('#coachBoard').isVisible(), false, 'Settled lobby must keep the board hidden.');
        await page.goto(`${origin}/#bots`, { waitUntil: 'domcontentloaded' });
        await page.locator('#aiBotRoster [data-ai-bot-play]').first().click();
        await page.waitForFunction(() => document.getElementById('aiGameReady')?.dataset.ready === 'true', null, { timeout: 15000 });
        await page.locator('#aiGameReadyStart').click();
        await page.waitForFunction(() => document.getElementById('play')?.classList.contains('is-active-game') && document.querySelectorAll('#coachBoard [data-square]').length === 64 && document.getElementById('coachBoard').getBoundingClientRect().width > 0, null, { timeout: 15000 });
        assert.equal(await page.locator('#coachBoard [data-square]').count(), 64);
        const geometry = await page.locator('#coachBoard').boundingBox();
        assert(geometry.width >= Math.min(width - 80, 220) && Math.abs(geometry.width - geometry.height) < 1, `Active board geometry invalid: ${JSON.stringify(geometry)}`);
        assert.equal(errors.length, 0, `Page errors: ${errors.join('; ')}`);
        console.log(`PASS delayed Play lobby, real bot controls and 64-square active board @ ${width}px`);
      } finally { release(); await context.close(); }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
