const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('assets/app.js','utf8');
const start = source.indexOf('      const hasSpecialGame =');
const end = source.indexOf('      if (!isPreGame)', start);
assert(start >= 0 && end > start);
const cases = [
  {label:'ordinary lobby',pre:true,special:false,state:null,expected:false},
  {label:'ordinary active board',pre:false,special:false,state:null,expected:true},
  {label:'pending Friend lobby',pre:false,special:true,state:{remote:true,status:'pending',active:false},expected:false},
  {label:'accepted lobby',pre:false,special:true,state:{remote:true,status:'accepted',active:false},expected:false},
  {label:'active Friend/tournament game',pre:false,special:true,state:{remote:true,status:'active',active:true},expected:true},
  {label:'completed remote game',pre:false,special:true,state:{remote:true,status:'completed',active:false},expected:true},
  {label:'cancelled game',pre:false,special:true,state:{remote:true,status:'cancelled',active:false},expected:false},
  {label:'review route',pre:false,special:true,state:{remote:true,status:'active',active:true},review:true,expected:false}
];
for (const c of cases) {
  let active;
  vm.runInNewContext(source.slice(start,end),{isPreGame:c.pre,inReview:!!c.review,isSpecialLobby:c.special,friendChallengeState:c.state,play:{classList:{toggle(name,value){assert.equal(name,'is-active-game');active=value;}}}});
  assert.equal(active,c.expected,c.label);
}
console.log('Play active state: eight shipped lobby, Friend/tournament, completion and Review cases pass');
