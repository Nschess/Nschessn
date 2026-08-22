const fs = require("node:fs");

const app = fs.readFileSync("assets/app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");

if (!/auth\.signOut\(\)/.test(app)) throw new Error("Supabase local logout must call auth.signOut() without a UI-only shortcut.");
if (!/let authGeneration = 0/.test(app) || !/generation !== authGeneration/.test(app)) throw new Error("Auth hydration needs generation guards against stale post-logout callbacks.");
if (!/let signOutInFlight = null/.test(app) || !/if \(signOutInFlight\) return signOutInFlight/.test(app)) throw new Error("Logout must be idempotent while a sign-out request is in flight.");
if (!/clearSession\(\);[\s\S]{0,500}authDebug\("Local logout completed"/.test(app)) throw new Error("Successful local logout must clear the session and cached auth state.");
if (!/window\.clearTimeout\(cloudProfileSyncTimer\);[\s\S]{0,100}cloudProfileSyncTimer = 0;/.test(app)) throw new Error("Logout must cancel pending authenticated profile writes.");
if (!/const currentAccount = provider\.getCachedAccount\?\.\(\) \|\| null;[\s\S]{0,260}if \(!account \|\| !currentAccount/.test(app)) throw new Error("In-flight profile refresh must not reapply an account after logout.");
if (!/id="authPanelLogout"/.test(html) || !/id="authPanelLogoutAll"/.test(html)) throw new Error("Logout controls are missing from the authenticated account panel.");
const retiredProvider = ["face", "book"].join("");
const retiredSelectors = ["auth", retiredProvider, "Login"].join("");
const retiredHandler = ["start", retiredProvider, "Login"].join("");
if (new RegExp(`${retiredProvider}|${retiredSelectors}|${retiredHandler}`, "i").test(app) || new RegExp(`${retiredProvider}|${retiredSelectors}|${retiredHandler}`, "i").test(html)) throw new Error("Retired OAuth provider references remain active.");
console.log("auth-logout-regression: lifecycle, signOut, race, duplicate-click, and provider-removal contracts passed");
