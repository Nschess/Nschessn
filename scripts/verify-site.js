const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) throw new Error(`Expected one inline application script, found ${scripts.length}.`);
new Function(scripts[0][1]);

const manifest = JSON.parse(fs.readFileSync("site.webmanifest", "utf8"));
if (manifest.start_url !== "./" || !Array.isArray(manifest.icons) || !manifest.icons.length) {
  throw new Error("The web manifest needs a relative start URL and at least one icon.");
}

const requiredMetadata = ["description", "robots", "theme-color", "og:title", "og:description"];
for (const name of requiredMetadata) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["']`, "i");
  if (!pattern.test(html)) throw new Error(`Missing required metadata: ${name}.`);
}

if (!/<main id="top" tabindex="-1">/.test(html)) {
  throw new Error("The skip link target must be keyboard focusable.");
}

console.log("Site structure and inline application syntax verified.");
