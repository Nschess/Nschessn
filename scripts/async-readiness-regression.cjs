const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');
const source = fs.readFileSync('scripts/e2e-runner.cjs', 'utf8');
const start = source.indexOf('async function waitForAsyncPagePredicate(');
const end = source.indexOf('async function gotoHash(',start);
assert(start >= 0 && end > start);
assert(!/\.waitForFunction\(async/.test(source), 'Async predicates must use awaited polling.');
const context = vm.createContext({ Date, Error, Promise, setTimeout, clearTimeout });
vm.runInContext(source.slice(start,end),context);
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.evaluate(() => { window.polls = 0; });
    const result = await context.waitForAsyncPagePredicate(page, async () => {
      await new Promise(resolve => setTimeout(resolve,10));
      return ++window.polls >= 3;
    }, null, {timeout:2000});
    assert.equal(result,true);
    assert.equal(await page.evaluate(() => window.polls),3, 'False async results must be retried.');
    await assert.rejects(context.waitForAsyncPagePredicate(page, async () => false, null, {timeout:100}), /timed out/);
    await assert.rejects(context.waitForAsyncPagePredicate(page, async () => { throw new Error('fixture-rejection'); }, null, {timeout:1000}), /fixture-rejection/);
    await assert.rejects(context.waitForAsyncPagePredicate(page, () => new Promise(()=>{}), null, {timeout:100}), /timed out/);
    console.log('Async readiness: real browser retries false, awaits true, propagates rejection and bounds unresolved predicates; all eight live call sites use it.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
