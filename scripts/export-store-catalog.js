/*
 * Build the server catalog payload from the real frontend storeItems array.
 * This deliberately evaluates only the data/declaration prefix of app.js; it
 * never boots the app, touches a browser, or reads a user/session.
 *
 * Usage:
 *   node scripts/export-store-catalog.js --out supabase/store-catalog.json
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "assets", "app.js");
const defaultOutput = path.join(root, "supabase", "store-catalog.json");

function noop() {}

function makeElement() {
  return new Proxy({
    style: {},
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    removeAttribute: noop,
    appendChild: noop,
    append: noop,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
  }, { get(target, key) { return key in target ? target[key] : noop; } });
}

function loadFrontendStoreItems() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const endMarker = "    function cloneStorePrefs";
  const end = source.indexOf(endMarker);
  if (end < 0) throw new Error(`Could not find ${endMarker} in ${sourcePath}`);

  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const document = new Proxy({
    baseURI: "http://catalog-export.invalid/",
    visibilityState: "visible",
    body: makeElement(),
    head: makeElement(),
    documentElement: makeElement(),
    activeElement: null
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createElement") return makeElement;
      if (key === "querySelectorAll") return () => [];
      if (key === "querySelector") return () => null;
      return noop;
    }
  });
  const location = { hostname: "localhost", protocol: "http:", origin: "http://localhost", href: "http://localhost/", search: "" };
  const window = new Proxy({
    document,
    location,
    navigator: { userAgent: "catalog-export", onLine: true },
    localStorage: storage,
    sessionStorage: storage,
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop })
  }, { get(target, key) { return key in target ? target[key] : noop; } });
  const context = {
    window,
    document,
    location,
    navigator: window.navigator,
    localStorage: storage,
    sessionStorage: storage,
    crypto: webcrypto,
    performance: window.performance,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Intl,
    TextEncoder,
    TextDecoder,
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    Event: function Event() {},
    CustomEvent: function CustomEvent() {}
  };
  context.globalThis = context;
  vm.runInNewContext(`${source.slice(0, end)}\n;globalThis.__storeItems = storeItems;`, context, { timeout: 15000 });
  if (!Array.isArray(context.__storeItems)) throw new Error("Frontend storeItems did not evaluate to an array.");
  return context.__storeItems;
}

function toCatalogRow(item) {
  if (!item || !item.id || !item.type || !item.name) throw new Error("Every store item needs id, type, and name.");
  const unlockMethod = ["Coins", "Achievement", "Season", "Event"].includes(String(item.unlockMethod))
    ? String(item.unlockMethod)
    : (item.awardOnly ? "Achievement" : "Coins");
  const metadata = {};
  const canonical = new Set(["id", "type", "name", "cost", "rarity", "unlockMethod", "giftable", "active"]);
  for (const [key, value] of Object.entries(item)) {
    if (canonical.has(key) || value === undefined || typeof value === "function") continue;
    metadata[key] = value;
  }
  metadata.unlockLabel = item.unlockLabel || (unlockMethod === "Coins"
    ? (Number(item.cost) > 0 ? `${Number(item.cost)} coins` : "Free")
    : `${unlockMethod} unlock`);
  return {
    item_id: String(item.id),
    item_type: String(item.type),
    name: String(item.name),
    cost_coins: Math.max(0, Number(item.cost) || 0),
    rarity: String(item.rarity || "Common"),
    unlock_method: unlockMethod,
    giftable: item.giftable !== false && unlockMethod === "Coins",
    active: item.active !== false,
    metadata
  };
}

function main() {
  const outputArg = process.argv.indexOf("--out");
  const output = path.resolve(root, outputArg >= 0 ? process.argv[outputArg + 1] : defaultOutput);
  const items = loadFrontendStoreItems();
  const rows = items.map(toCatalogRow);
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.item_id)) throw new Error(`Duplicate frontend Store item ID: ${row.item_id}`);
    ids.add(row.item_id);
  }
  const byType = rows.reduce((counts, row) => { counts[row.item_type] = (counts[row.item_type] || 0) + 1; return counts; }, {});
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, total: rows.length, byType }, null, 2));
}

main();
