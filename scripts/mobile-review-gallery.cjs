// Generates ignored QA evidence only; reference screenshots never enter dist.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'../e2e-artifacts');
const read = name => JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const before = read('phase10/before-matched/report.json');
const after = read('phase10/matched-after/report.json');
const reference = read('mobile-reference/report.json');
const escape = value => String(value ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const image = (file,label) => `<figure><figcaption>${escape(label)}</figcaption><a href="${file}"><img loading="lazy" src="${file}" alt="${escape(label)}"></a></figure>`;
const map = {'daily-active':'puzzle','lesson-active':'lesson','play-active':'computer-setup','bot-ready-dialog':'computer-setup'};
const rows = after.states.filter(s=>s.board).map(s=>{
  const b=before.states.find(v=>v.name===s.name&&v.width===s.width&&v.height===s.height);
  const ref=reference.results.find(v=>v.name===(map[s.name] || (s.name.startsWith('puzzle-')?'puzzle':null))&&v.width===s.width&&v.height===s.height);
  return {activity:s.name,width:s.width,height:s.height,before:b?.board,after:s.board,reference:ref?.board};
});
let html=`<!doctype html><meta charset="utf-8"><title>Nschess mobile comparison</title><style>body{font:15px system-ui;background:#0b1323;color:#edf2ff;margin:24px}h1,h2{line-height:1.3}section{margin:32px 0;padding:16px;border:1px solid #45516b}aside{max-width:90ch}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #45516b}a{color:#9fcfff}.shots{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;width:min(100%,390px)}img{max-width:100%;height:auto}figcaption{margin:8px 0}details{margin:18px 0}</style><h1>Nschess: matched mobile evidence</h1><aside><p>Base: 003967556ef0625276a849939dfab49e7dea6a32. Real Chromium screenshots at identical viewport sizes. Local Nschess uses inert backend fixtures; Lichess uses public pages, with non-read requests blocked. No Lichess game or authenticated journey was created. Computer setup is not proof of a played game.</p><p>Server game/account facts remain distinct from client analysis and device-local practice. Lichess images are internal QA evidence only, not Nschess product assets. Full-page Nschess activity images show scrollable context; reference images are viewport captures. Board top and width measurements are taken at scroll zero.</p></aside><h2>Board measurements (pixels)</h2><table><tr><th>Activity / viewport</th><th>Before width / top</th><th>After width / top</th><th>Safe width used</th><th>Reference width / top</th></tr>`;
for(const r of rows) html+=`<tr><td>${escape(r.activity)} ${r.width}×${r.height}</td><td>${r.before?.width.toFixed(1)} / ${r.before?.top.toFixed(1)}</td><td>${r.after.width.toFixed(1)} / ${r.after.top.toFixed(1)}</td><td>${r.after.usablePercent.toFixed(1)}%</td><td>${r.reference?`${r.reference.width.toFixed(1)} / ${r.reference.top.toFixed(1)}`:'Not an equivalent public game'}</td></tr>`;
html+='</table>';
for(const s of after.states){
  const key=`${s.name}-${s.width}x${s.height}.png`;
  const ref=map[s.name] || (s.name.startsWith('puzzle-')?'puzzle':null);
  const refFile = ref && `mobile-reference/${ref}-${s.width}x${s.height}.png`;
  const boardFile = `phase10/matched-after/${key.replace('.png','-board.png')}`;
  html+=`<details ${s.width===390&&s.height===844?'open':''}><summary>${escape(s.name)} ${s.width}×${s.height}</summary><div class="shots">${image(`phase10/before-matched/${key}`,'Nschess before')}${image(`phase10/matched-after/${key}`,'Nschess after')}${fs.existsSync(path.join(root,boardFile))?image(boardFile,'Nschess board in view'):''}${refFile&&fs.existsSync(path.join(root,refFile))?image(refFile,'Public Lichess reference'):''}</div></details>`;
}
html+='<h2>All 20 routes: final 390×844 appearance</h2><div class="shots">';
for(const route of ['top','play','bots','puzzles','tutorial','game-review','friends','login','store','settings','leaderboards','academy','paths','adventures','rules','openings','books','notation','plan','videos']) html+=image(`phase10/matched-after/${route}-390x844.png`,route);
html+='</div><h2>Review fullscreen</h2><div class="shots">';
for (const width of [320,375,390,430,768,844,1366]) {
  const beforeFile=`review-before/fullscreen-${width}.png`;
  if(fs.existsSync(path.join(root,beforeFile))) html+=image(beforeFile,`Review before ${width}px`);
  html+=image(`phase10/review/fullscreen-${width}.png`, `Review after ${width}px`);
}
html+='</div><h2>Limitations</h2><p>No physical-device usability study or authenticated live backend acceptance was performed. Nschess retains a taller branded navigation and mode/lesson context than Lichess. Portrait board safe width is viewport minus 24px; landscape boards intentionally preserve vertical fit. Manual screen-reader/contrast and safe-area device checks remain future validation, not claimed passes.</p>';
html=html.replace('Full-page Nschess activity images show scrollable context; reference images are viewport captures.', 'Nschess and reference images are viewport captures. Separate board-in-view images verify scrolled interaction surfaces.');
fs.writeFileSync(path.join(root,'mobile-review-gallery.html'),html);
fs.writeFileSync(path.join(root,'mobile-board-comparison.json'),JSON.stringify(rows,null,2));
console.log(`Generated ${rows.length} matched board comparisons and 20-route gallery.`);
