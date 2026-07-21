const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || path.resolve(__dirname, ".."));
const indexPath = path.join(siteDir, "index.html");
const html = fs.readFileSync(indexPath, "utf8");
const required = [
  "index.html",
  "assets/kingnorbert-coach.png",
  "assets/stockfish/stockfish-nnue-16-single.js",
  "assets/stockfish/stockfish-nnue-16-single.wasm"
];

const refs = new Set(required);
const addRef = (value) => {
  if (!value || /^(https?:|data:|#|mailto:|javascript:)/i.test(value)) return;
  if (/^(top|play|puzzles|store|login|settings|videos|books|plan|rules|openings|adventures|tutorial|academy|leaderboards|notation|shorts)$/i.test(value.replace(/^#/, ""))) return;
  if (value.startsWith("#")) return;
  refs.add(value.split(/[?#]/)[0]);
};

for (const match of html.matchAll(/<[^>]+\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) addRef(match[1]);
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n");
for (const match of styles.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) addRef(match[1]);

const missing = [...refs]
  .filter((ref) => !ref.includes("*"))
  .filter((ref) => !ref.includes("${"))
  .map((ref) => ({ ref, file: path.join(siteDir, ref) }))
  .filter(({ file }) => !fs.existsSync(file));

if (missing.length) {
  console.error("Missing deploy assets:");
  missing.forEach(({ ref }) => console.error(`- ${ref}`));
  process.exit(1);
}

console.log(`Deploy asset check passed (${refs.size} local refs).`);
