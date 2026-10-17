const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('scripts/e2e-runner.cjs', 'utf8');
const start = source.indexOf('await page.waitForFunction(', source.indexOf('async function waitForStorePurchaseSettlement(')) + 'await page.waitForFunction('.length;
const end = source.indexOf(', itemId, { timeout: 15000 });', start);
assert(start > 0 && end > start);
let owned = true, equipped = true, pending = false, busy = false, category = 'is-highlight', disabled = false, text = 'Unequip';
const action = { get disabled() { return disabled; }, get textContent() { return text; }, classList: { contains: name => name === 'is-pending' && pending }, getAttribute: () => busy ? 'true' : null };
const card = { dataset: { storeItemId: 'fixture' }, classList: { contains: name => ({ 'is-owned': owned, 'is-equipped': equipped, 'is-pending': pending }[name] ?? (name === category)) }, getAttribute: () => busy ? 'true' : 'false', querySelector: () => action };
const status = { dataset: {}, getAttribute: () => busy ? 'true' : null };
const predicate = vm.runInNewContext('(' + source.slice(start,end) + ')', { document: { querySelectorAll: () => [card], getElementById: () => status } });
assert(predicate('fixture'), 'Equipped reversible Last Move must settle.');
category = 'is-name-style'; assert(predicate('fixture'), 'Equipped reversible Name Style must settle.');
category = ''; assert(!predicate('fixture'), 'Unrelated enabled Unequip must not settle.');
disabled = true; text = 'Equipped'; assert(predicate('fixture'), 'Regular disabled Equipped must settle.');
for (const state of ['owned','equipped','pending','busy','lock']) {
  if (state === 'owned') owned = false;
  if (state === 'equipped') equipped = false;
  if (state === 'pending') pending = true;
  if (state === 'busy') busy = true;
  if (state === 'lock') status.dataset.storePendingItem = 'fixture';
  assert(!predicate('fixture'), `Invalid purchase state must fail: ${state}`);
  owned = equipped = true; pending = busy = false; delete status.dataset.storePendingItem;
}
console.log('Store purchase settlement: reversible categories and strict ownership/equipment/pending/busy/lock checks pass');
