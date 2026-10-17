const fs = require("node:fs");

const app = fs.readFileSync("assets/app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");

if (!/auth\.signOut\(\{\s*scope:\s*["']local["']\s*\}\)/.test(app)) throw new Error("Supabase local logout must explicitly use the local scope.");
if (!/let authGeneration = 0/.test(app) || !/generation !== authGeneration/.test(app)) throw new Error("Auth hydration needs generation guards against stale post-logout callbacks.");
if (!/let pendingSession = null/.test(app)
  || !/let pendingSessionGeneration = 0/.test(app)
  || !/pendingSession = data\.session/.test(app)
  || !/getRecoverableSession\(\)/.test(app)
  || !/Ignored stale signed-out event after newer session/.test(app)) {
  throw new Error("A newly accepted login session must remain protected while delayed logout events are drained.");
}
if (!/const current = await supabase\.auth\.getSession\(\)\.catch\(/.test(app)
  || !/Ignored stale signed-out event; current session restored/.test(app)) {
  throw new Error("A delayed signed-out event must revalidate the current Supabase session before it can clear a newer account.");
}
if (!/let signOutInFlight = null/.test(app) || !/if \(signOutInFlight\) return signOutInFlight/.test(app)) throw new Error("Logout must be idempotent while a sign-out request is in flight.");
if (!/clearSession\(\);[\s\S]{0,500}authDebug\("Local logout completed"/.test(app)) throw new Error("Successful local logout must clear the session and cached auth state.");
if (!/window\.clearTimeout\(cloudProfileSyncTimer\);[\s\S]{0,100}cloudProfileSyncTimer = 0;/.test(app)) throw new Error("Logout must cancel pending authenticated profile writes.");
if (!/const currentAccount = provider\.getCachedAccount\?\.\(\) \|\| null;[\s\S]{0,260}if \(!account \|\| !currentAccount/.test(app)) throw new Error("In-flight profile refresh must not reapply an account after logout.");
if (!/const accountWorkspaceStorageKey = "checkmateQuest\.accountWorkspaces\.v1"/.test(app)
  || !/function switchAccountWorkspace\(/.test(app)
  || !/function clearAccountWorkspaceAfterLogout\(/.test(app)
  || !/function hydrateAccountWorkspaceRuntimeState\(/.test(app)) {
  throw new Error("Account-owned progress/cosmetic state must be isolated behind a shared workspace boundary.");
}
for (const key of [
  "checkmateQuest.academy.v1",
  "checkmateQuest.dailyTraining.v1",
  "checkmateQuest.dailyPractice.v1",
  "checkmateQuest.gentleStart.v1",
  "checkmateQuest.firstTimeTour.v1",
  "checkmateQuest.firstVisitSetup.v1",
  "checkmateQuest.authPreferences.v1"
]) {
  if (!app.includes(`"${key}"`)) {
    throw new Error(`Account workspace is missing the scoped key ${key}.`);
  }
}
if (!/function resetApplicationAccountState\(/.test(app)
  || !/resetApplicationAccountState\(previousAccountId, \{ status: "loading", render: true \}\)/.test(app)
  || !/resetApplicationAccountState\(previousAccountId, \{ status: nextStatus, render: true \}\)/.test(app)) {
  throw new Error("Logout and A-to-B account transitions must use the same centralized anonymous reset.");
}
if (/migrateLegacyWorkspaceForAccount/.test(app)) throw new Error("Legacy email-based workspace migration can leak one account into another and must remain retired.");
if (!/const saved = Array\.isArray\(rows\) \? rows\[0\] : null;[\s\S]{0,180}cachedAccount = \{/.test(app)) throw new Error("Profile writes must not repopulate cached identity after a stale auth generation.");
if (!/id="authPanelLogout"/.test(html) || !/id="authPanelLogoutAll"/.test(html)) throw new Error("Logout controls are missing from the authenticated account panel.");
const retiredProvider = ["face", "book"].join("");
const retiredSelectors = ["auth", retiredProvider, "Login"].join("");
const retiredHandler = ["start", retiredProvider, "Login"].join("");
if (new RegExp(`${retiredProvider}|${retiredSelectors}|${retiredHandler}`, "i").test(app) || new RegExp(`${retiredProvider}|${retiredSelectors}|${retiredHandler}`, "i").test(html)) throw new Error("Retired OAuth provider references remain active.");
console.log("auth-logout-regression: lifecycle, signOut, race, duplicate-click, and provider-removal contracts passed");

// Exercise the shipped provider cleanup: a delayed/repeated sign-out must not
// recreate an account-owned authPreferences object in the anonymous workspace.
const vm = require('node:vm');
const assert = require('node:assert/strict');
const cleanupStart = app.indexOf('      const clearSession = (');
const cleanupEnd = app.indexOf('      const safeAuthMetadataUsername', cleanupStart);
assert(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'Shipped session cleanup must be extractable.');
const cleanup = app.slice(cleanupStart, cleanupEnd);
const storage = new Map([['test.authPreferences', JSON.stringify({ currentEmail: 'fixture@example.invalid', rememberEmail: 'fixture@example.invalid', accountOnly: 'fixture' })]]);
const context = vm.createContext({
  localStorage: { removeItem: key => storage.delete(key) },
  stopSessionRefresh() {}, clearSupabaseBrowserAuthStorage() {},
  authPreferencesStorageKey: 'test.authPreferences',
  authGeneration: 1, activeSession: { user: { id: 'fixture-a' } },
  activeSessionGeneration: 1, pendingSession: {}, pendingSessionGeneration: 1,
  cachedAccount: { id: 'fixture-a' }
});
vm.runInContext(`${cleanup}; clearSession(); clearSession();`, context);
assert.equal(storage.has('test.authPreferences'), false, 'Repeated cleanup must leave no account preferences in the guest workspace.');
assert.equal(context.activeSession, null);
assert.equal(context.cachedAccount, null);
assert.equal(context.pendingSession, null);
assert.equal(context.authGeneration, 3);
console.log('auth-logout-regression: shipped repeated session cleanup leaves no guest authPreferences record');

// Execute the shipped cross-account leak predicate with a shared currency glyph
// and genuine stale avatar/style fields. Neither assertion is a blanket bypass.
const runnerSource = fs.readFileSync('scripts/e2e-runner.cjs', 'utf8');
const predicateStart = runnerSource.indexOf('=> pageHandle.evaluate(') + '=> pageHandle.evaluate('.length;
const predicateEnd = runnerSource.indexOf(', { prior: priorIdentity, current: currentIdentity });', predicateStart);
assert(predicateStart > 0 && predicateEnd > predicateStart);
const predicateContext = vm.createContext({ document: { querySelectorAll(selector) {
  if (selector === '.player-profile-avatar, #authAccountAvatar') return predicateContext.avatars;
  if (selector === '.player-identity-line[data-identity-owner="player"]') return predicateContext.styles;
  return [{ innerText: 'Fixture B ◆ 0 coins' }];
} }, avatars: [{ textContent: '♞' }], styles: [{ dataset: { identityNameStyle: 'violet' } }] });
const identityPredicate = vm.runInContext('(' + runnerSource.slice(predicateStart, predicateEnd) + ')', predicateContext);
const identities = { prior: { name: 'Fixture A', avatar: '◆', nameStyle: 'sky' }, current: { name: 'Fixture B', avatar: '♞', nameStyle: 'violet' } };
assert.equal(identityPredicate(identities).length, 0, 'A shared currency glyph is not a stale avatar.');
predicateContext.avatars.push({ textContent: '◆' });
assert(identityPredicate(identities).includes('◆'), 'A stale mounted avatar must still fail isolation.');
predicateContext.styles.push({ dataset: { identityNameStyle: 'sky' } });
assert(identityPredicate(identities).includes('sky'), 'A stale equipped style must still fail isolation.');
console.log('auth-logout-regression: semantic isolation detects stale avatars/styles without currency false positives');

const metricsStart = runnerSource.indexOf('function assertAnonymousProfileMetrics(');
const metricsEnd = runnerSource.indexOf('async function runAuthenticatedBrowserTests(', metricsStart);
assert(metricsStart >= 0 && metricsEnd > metricsStart);
const metricsContext = vm.createContext({ assert: (condition, message) => assert(condition, message) });
vm.runInContext(runnerSource.slice(metricsStart, metricsEnd), metricsContext);
const anonymousMetrics = { name: 'Guest Explorer', rank: 'Guest profile', gameRating: '—', puzzleRating: '—', gamesPlayed: '— games', winRate: '—', streak: '—', xp: '—', tokens: '—', achievements: '0/0 on this device', storeCoins: '0' };
metricsContext.assertAnonymousProfileMetrics(anonymousMetrics, 'fixture');
for (const field of Object.keys(anonymousMetrics)) {
  assert.throws(() => metricsContext.assertAnonymousProfileMetrics({ ...anonymousMetrics, [field]: 'authenticated-fixture-value' }, 'fixture'), undefined, 'Stale guest metric must fail: ' + field);
}
console.log('auth-logout-regression: exact anonymous placeholders pass and every stale metric field fails');

const visitStart = app.indexOf('    function rememberVisitSnapshot()');
const visitEnd = app.indexOf('    function getMissionWeekKey(', visitStart);
assert(visitStart >= 0 && visitEnd > visitStart);
const visits = [];
const visitContext = vm.createContext({
  authenticated: false, snapshot: { date: 'fixture-day', xp: 0, solved: 0, coins: 0, streak: 0, best: 0, lessons: 0, games: 0 },
  isApplicationAuthenticated: () => visitContext.authenticated,
  getCurrentVisitSnapshot: () => visitContext.snapshot,
  visitSnapshotStorageKey: 'fixture.visit', writeJsonStorage: (key, value) => visits.push({ key, value })
});
vm.runInContext(app.slice(visitStart, visitEnd), visitContext);
visitContext.rememberVisitSnapshot();
assert.equal(visits.length, 0, 'Untouched guest exit must not recreate a scoped snapshot.');
for (const field of ['xp', 'solved', 'coins', 'streak', 'best', 'lessons', 'games']) {
  visitContext.snapshot[field] = 1; visitContext.rememberVisitSnapshot();
  assert.equal(visits.at(-1).value[field], 1, 'Real guest activity must retain its recap.');
  visitContext.snapshot[field] = 0;
}
visitContext.authenticated = true; visitContext.rememberVisitSnapshot();
assert.equal(visits.length, 8, 'Authenticated zero-activity snapshots remain supported.');
console.log('auth-logout-regression: empty guest exit stays clean; real guest and authenticated recaps persist');
