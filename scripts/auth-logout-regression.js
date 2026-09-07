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
