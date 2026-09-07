const fs = require("fs");
const path = require("path");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "dist");
const staticEntries = [
  "index.html",
  "privacy.html",
  "terms.html",
  "account-deletion.html",
  "offline.html",
  "service-worker.js",
  "favicon.svg",
  "site.webmanifest",
  "robots.txt",
  ".nojekyll",
  "assets",
  "data",
  // Public compliance materials accompany the static release artifact.
  "THIRD-PARTY-NOTICES.md",
  "docs/ASSET-LICENSE-LEDGER.md",
  "docs/STORE-MUSIC-LICENSES.md",
  "docs/THIRD-PARTY-SOURCE-MANIFEST.md",
  "docs/STOCKFISH-CORRESPONDING-SOURCE.md",
  "docs/licenses"
];

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const entry of staticEntries) {
  const source = path.join(projectDir, entry);
  if (!fs.existsSync(source)) {
    console.error(`Missing required static entry: ${entry}`);
    process.exit(1);
  }
  fs.cpSync(source, path.join(outputDir, entry), { recursive: true });
}

console.log(`Built GitHub Pages artifact in ${path.relative(projectDir, outputDir)}.`);
