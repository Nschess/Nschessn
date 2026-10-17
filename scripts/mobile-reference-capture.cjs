// Read-only public reference capture. Screenshots are ignored internal QA only.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sizes = [[320,700],[360,780],[375,812],[390,844],[430,932],[768,1024],[1366,768],[390,650],[844,390],[768,768]];
const output = path.resolve(__dirname, '../e2e-artifacts/mobile-reference');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: {width:390,height:844} });
  const results = [];
  try {
    // Never start a game, submit an answer, sign in, or send a non-read request.
    await context.route('**/*', route => ['GET','HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    for (const [name, url] of [['home','https://lichess.org/'],['puzzle','https://lichess.org/training'],['analysis','https://lichess.org/analysis'],['lesson','https://lichess.org/learn#/1/1']]) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout:30000 });
      if (name === 'lesson') {
        const start = page.getByRole('button', { name:"LET'S GO!" });
        if (await start.isVisible()) await start.click();
      }
      if (name !== 'home') await page.locator('cg-board').first().waitFor({ state:'visible' });
      await page.evaluate(() => document.fonts.ready);
      for (const [width,height] of sizes) {
        await page.setViewportSize({width,height});
        await page.waitForTimeout(200);
        await page.evaluate(() => window.scrollTo(0,0));
        const sample = await page.evaluate(() => {
          const rect = e => {const r=e.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom};};
          const boards = [...document.querySelectorAll('cg-board')].filter(e=>e.getBoundingClientRect().width>0).map(rect);
          const board=boards[0] || null;
          return {width:innerWidth,height:innerHeight,usableWidth:document.documentElement.clientWidth,
            overflow:document.documentElement.scrollWidth-innerWidth,board,
            boardPercent:board?board.width/document.documentElement.clientWidth*100:null,
            scrollForFullBoard:board?Math.max(0,board.bottom-innerHeight):null,
            navigation:document.querySelector('#top')?rect(document.querySelector('#top')):null};
        });
        await page.screenshot({path:path.join(output,`${name}-${width}x${height}.png`), animations:'disabled'});
        results.push({name,url,...sample});
      }
    }
    await page.goto('https://lichess.org/',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'Play against computer'}).click();
    for (const [width,height] of sizes.slice(0,7)) {
      await page.setViewportSize({width,height});
      await page.screenshot({path:path.join(output,`computer-setup-${width}x${height}.png`),animations:'disabled'});
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({browser:browser.version(),results,limitations:['No remote Lichess game created; computer setup only.','Public analysis, puzzle and lesson boards; no authenticated account journeys.']},null,2));
    console.log(JSON.stringify({result:'PASS',samples:results.length,output}));
  } finally { await context.close(); await browser.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
