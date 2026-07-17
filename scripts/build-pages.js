const fs = require("fs");
const path = require("path");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "dist");
const staticEntries = ["index.html", "favicon.svg", "site.webmanifest", "robots.txt", ".nojekyll", "assets", "data"];

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
