// Non-destructive guest production smoke. No credentials, account writes or RPCs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const origin = process.env.NSCHESS_SMOKE_ORIGIN || 'https://nschessn.vercel.app';
const target = new URL(origin);
assert.ok(origin === 'https://nschessn.vercel.app' || (target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.pathname === '/'), 'Only the approved production site or isolated loopback rehearsal is allowed');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'e2e-artifacts/live-mobile');
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const evidence={origin,assets:[],viewports:[],errors:[],failures:[],limitations:['Guest only; no production accounts, transactions or database inspection.','Physical devices and authenticated backend behavior not verified.']};
  for(const name of ['index.html','assets/app.css','assets/app.js','service-worker.js']){
    const response=await fetch(`${origin}/${name}`,{signal:AbortSignal.timeout(30000),cache:'no-store'});
    assert.equal(response.status,200,`${name} served successfully`);
    const actual=(await response.text()).replace(/\r/g,'');
    const expected=fs.readFileSync(path.join(root,name),'utf8').replace(/\r/g,'');
    assert.equal(actual,expected,`${name} matches the exact local release source`);
    evidence.assets.push({name,exact:true});
  }
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,serviceWorkers:'allow'});
    await context.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url());
      if(!['GET','HEAD'].includes(request.method()) || url.hostname.endsWith('.supabase.co')) return route.abort();
      return route.continue();
    });
    const page=await context.newPage();
    page.setDefaultTimeout(20000);
    // The first-visit dialog is scheduled after startup. Dismiss it through
    // its real control whenever it appears, not a premature visibility poll.
    await page.addLocatorHandler(page.locator('#firstVisitSetup'), async()=>{
      await page.locator('#firstVisitSetupLater').tap();
    });
    page.on('pageerror',e=>evidence.errors.push(e.message));
    let offlinePhase=false;
    page.on('requestfailed',r=>{const url=new URL(r.url());if(url.origin===origin && ['GET','HEAD'].includes(r.method()) && !(offlinePhase && url.pathname==='/api/auth-config')) evidence.failures.push(url.pathname)});
    await page.goto(origin,{waitUntil:'load',timeout:30000});
    if(await page.locator('#firstVisitSetup').isVisible()) await page.locator('#firstVisitSetupLater').tap();
    for(const route of ['top','play','bots','puzzles','tutorial','game-review','settings','login']){
      await page.goto(`${origin}/#${route}`,{waitUntil:'domcontentloaded'});
      await page.locator(`#${route==='game-review'?'gameReview':route}`).waitFor({state:'visible'});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
      assert.ok(overflow<=1,`${route} fits 390px`);
    }
    await page.goto(`${origin}/#bots`);
    await page.locator('[data-ai-bot-play="bot-pebble"]').tap();
    await page.locator('[data-ai-game-ready-pace="none"]').tap();
    await page.locator('#aiGameReadyStart').tap();
    await page.waitForFunction(()=>document.querySelectorAll('#coachBoard [data-square]').length===64);
    await page.locator('#coachBoard [data-square="e2"]').tap();
    await page.locator('#coachBoard [data-square="e4"]').tap();
    evidence.playMove=await page.locator('#coachBoard [data-square="e4"] [data-piece]').getAttribute('data-piece');
    assert.equal(evidence.playMove,'wp','the actual white pawn mounted at e4');
    await page.goto(`${origin}/#puzzles`);
    await page.locator('[data-daily-puzzle-launch]').tap();
    await page.waitForFunction(()=>document.querySelectorAll('#dailyPuzzleBoard [data-square]').length===64);
    for(const [width,height] of [[320,700],[360,780],[375,812],[390,844],[430,932],[768,1024],[1366,768]]){
      await page.setViewportSize({width,height});
      await page.waitForTimeout(150);
      const state=await page.locator('#dailyPuzzleBoard').evaluate(el=>{const r=el.getBoundingClientRect();return {width:innerWidth,height:innerHeight,board:[r.width,r.height],squares:el.querySelectorAll('[data-square]').length,overflow:document.documentElement.scrollWidth-innerWidth}});
      assert.equal(state.squares,64);assert.ok(Math.abs(state.board[0]-state.board[1])<1);assert.ok(state.overflow<=1);
      evidence.viewports.push(state);
      await page.screenshot({path:path.join(output,`daily-${width}.png`)});
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#dailyPuzzleHintButton').tap();
    assert.equal(await page.locator('#dailyPuzzleHint').isVisible(),true,'the real hint opens');
    evidence.hint=await page.locator('#dailyPuzzleFeedback').textContent();
    await page.evaluate(()=>navigator.serviceWorker.ready);
    // Reopen under the active worker: first-install requests can precede
    // clients.claim(). Verify real cached dependencies before testing offline.
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('[data-daily-puzzle-launch]').tap();
    await page.waitForFunction(()=>document.querySelectorAll('#dailyPuzzleBoard [data-square]').length===64);
    await page.waitForFunction(async()=>Boolean(await caches.match('/assets/daily-puzzle-launcher.mjs?v=daily-compact-v1')) && Boolean(await caches.match('/assets/vendor/chess.js-1.0.0.mjs')));
    offlinePhase=true;
    await context.setOffline(true);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('[data-daily-puzzle-launch]').tap();
    await page.waitForFunction(()=>document.querySelectorAll('#dailyPuzzleBoard [data-square]').length===64);
    evidence.offlineDaily=true;
    evidence.cacheKeys=await page.evaluate(()=>caches.keys());
    assert.ok(evidence.cacheKeys.includes('nschess-shell-v199-daily-practice-seo'));
    assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.failures,[]);
    evidence.result='PASS';
    await context.close();
  }finally{await browser.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(evidence,null,2));}
  console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
