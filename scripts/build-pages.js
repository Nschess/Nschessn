const fs = require("fs");
const path = require("path");
const { origin, pages, legalPages, home, metadata, structuredData, renderPage } = require("./seo-pages.cjs");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "dist");
const staticEntries = [
  "index.html",
  "privacy.html",
  "terms.html",
  "account-deletion.html",
  "offline.html",
  "404.html",
  "service-worker.js",
  "favicon.svg",
  "site.webmanifest",
  "robots.txt",
  ".nojekyll",
  ".well-known/assetlinks.json",
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

// Public discovery pages contain real text and links before any JavaScript runs.
for (const page of pages) {
  const destination = path.join(outputDir, page.path, "index.html");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderPage(page));
}
const urls = [home, ...pages, ...legalPages].map((page) => origin + page.path);
fs.writeFileSync(path.join(outputDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}\n</urlset>\n`);
// Keep the checked-in shell metadata and the generated inventory in agreement.
const shell = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
if (!shell.includes(metadata(home)) || !shell.includes(structuredData(home))) throw new Error("Home SEO metadata differs from the reviewed inventory.");
console.log(`Built static artifact in ${path.relative(projectDir, outputDir)} (${urls.length} public sitemap URLs).`);
