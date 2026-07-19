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

const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const ids = [...markup.matchAll(/(?:^|\s)id=["']([^"']+)["']/gim)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicateIds.length) {
  throw new Error(`Duplicate static IDs: ${duplicateIds.join(", ")}.`);
}

for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls", "for"]) {
  const references = [...markup.matchAll(new RegExp(`(?:^|\\s)${attribute}=["']([^"']+)["']`, "gim"))]
    .flatMap((match) => match[1].trim().split(/\s+/));
  const missing = [...new Set(references.filter((reference) => reference && !ids.includes(reference)))];
  if (missing.length) {
    throw new Error(`Missing targets for ${attribute}: ${missing.join(", ")}.`);
  }
}

const imagesWithoutAlt = [...markup.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/gi)];
if (imagesWithoutAlt.length) {
  throw new Error(`Found ${imagesWithoutAlt.length} static image(s) without alternative text.`);
}

const requiredRegressionContracts = [
  ["homepage top-player target", /id="homeTopPlayers"/],
  ["homepage rankings renderer", /function renderHomeTopPlayers\(entries = buildLeaderboardEntries\("ai"\)\)/],
  ["homepage recent-game target", /id="homeRecentGames"/],
  ["completed-game persistence", /completedGames: completedGameHistory\.slice\(0, 12\)/],
  ["AI completed-game recording", /function recordCoachGameResult[\s\S]*?recordCompletedGame\(/],
  ["online completed-game recording", /remote\.status === "completed"[\s\S]*?recordCompletedGame\(/],
  ["header rating binding", /data-profile-field="gameRating"/],
  ["visible desktop profile metadata", /\.player-flex-chip > \.player-flex-main:last-child\s*\{\s*display: grid;/],
  ["player-card coins binding", /data-match-coins/],
  ["compact player-frame grid", /"footer footer footer"\s*\n\s*"details details details"/],
  ["board-dominant player-card stack", /grid-template-areas:\s*\n\s*"setup"\s*\n\s*"opponent"\s*\n\s*"board"\s*\n\s*"player"\s*\n\s*"actions"\s*\n\s*"options"/],
  ["viewport-balanced board sizing", /--cq-play-board-max: min\(760px, max\(420px, calc\(100svh - var\(--cq-play-stage-chrome\)\)\)\);/],
  ["live capture context priority", /#play \.captured-row \{\s*order: 1;/],
  ["mobile player-card breakpoint", /@media \(max-width: 480px\)[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\) max-content/]
];

for (const [label, pattern] of requiredRegressionContracts) {
  if (!pattern.test(html)) throw new Error(`Missing regression contract: ${label}.`);
}

console.log("Site structure and inline application syntax verified.");
