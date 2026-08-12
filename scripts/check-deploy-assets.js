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

const appJsPath = path.join(siteDir, "assets", "app.js");
if (fs.existsSync(appJsPath)) {
  const appJs = fs.readFileSync(appJsPath, "utf8");
  const themeMatch = appJs.match(/const requestedPieceSvgThemes = Object\.freeze\(\[([\s\S]*?)\]\);/);
  const assetMatch = appJs.match(/const pieceAssetFiles = Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (themeMatch && assetMatch) {
    const themes = [...themeMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const pieceFiles = [...assetMatch[1].matchAll(/:\s*"([^"]+\.svg)"/g)].map((match) => match[1]);
    themes.forEach((theme) => {
      pieceFiles.forEach((file) => addRef(`assets/pieces/${theme}/${file}`));
    });
  }
}

const missing = [...refs]
  .filter((ref) => !ref.includes("*"))
  .filter((ref) => !ref.includes("${"))
  .map((ref) => ({ ref, file: path.join(siteDir, ref) }))
  .filter(({ file }) => !fs.existsSync(file));

const invalidPieceSvgs = [...refs]
  .filter((ref) => /^assets\/pieces\/.+\.svg$/i.test(ref))
  .map((ref) => ({ ref, file: path.join(siteDir, ref) }))
  .filter(({ file }) => fs.existsSync(file))
  .filter(({ file }) => !/<svg[\s>]/i.test(fs.readFileSync(file, "utf8")));

if (missing.length || invalidPieceSvgs.length) {
  if (missing.length) {
    console.error("Missing deploy assets:");
    missing.forEach(({ ref }) => console.error(`- ${ref}`));
  }
  if (invalidPieceSvgs.length) {
    console.error("Invalid piece SVG assets:");
    invalidPieceSvgs.forEach(({ ref }) => console.error(`- ${ref}`));
  }
  process.exit(1);
}

console.log(`Deploy asset check passed (${refs.size} local refs).`);
