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
  ["homepage tournaments target", /id="homeTournaments"/],
  ["homepage tournaments renderer", /function renderHomeTournaments\([\s\S]*?tournamentRuntime\.events/],
  ["shared theme-aware UI tokens", /body\.theme-light\s*\{[\s\S]*?--cq-text-primary: #17213d;/],
  ["global header consistency adapter", /\.site-header \.nav-utilities \.player-flex-chip\s*\{[\s\S]*?background: var\(--cq-surface-input\);/],
  ["global footer consistency adapter", /\.footer \{[\s\S]*?background: var\(--cq-footer-surface\);/],
  ["global dialog consistency adapter", /:is\(\.audio-player, \.friend-challenge-notice, \.video-modal-panel\)/],
  ["profile performance ratings", /class="profile-rating-grid"[\s\S]*?data-profile-field="gameRating"[\s\S]*?data-profile-field="puzzleRating"/],
  ["profile rating-history renderer", /function renderProfileRatingHistory\(\)[\s\S]*?data-profile-rating-history/],
  ["profile achievement labels", /dataset\.profileAchievementLabel = achievement\.label/],
  ["leaderboard personal context", /class="leaderboard-overview cq-panel"[\s\S]*?data-leaderboard-puzzle-rank[\s\S]*?data-leaderboard-compare-fill/],
  ["leaderboard overview renderer", /function renderLeaderboardOverview\([\s\S]*?data-leaderboard-compare-fill/],
  ["social workspace consistency adapter", /#play :is\(\.friend-lobby, \.tournament-lobby\) \{/],
  ["learning workspace consistency adapter", /Phase 6: learning workspaces[\s\S]*?#tutorial \.tutorial-shell[\s\S]*?#puzzles \.real-puzzle-shell[\s\S]*?#plan \.plan-panel/],
  ["learning reduced-motion safeguards", /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?#puzzles \.mission-button/],
  ["incremental mini-board rendering", /function renderMiniBoard\([\s\S]*?createDocumentFragment\([\s\S]*?function renderMiniBoards\([\s\S]*?IntersectionObserver/],
  ["deferred static collection painting", /Phase 7: keep long, static collections[\s\S]*?content-visibility: auto/],
  ["lazy iframe fallback", /if \(!iframe\.hasAttribute\("loading"\)\) iframe\.loading = "lazy"/],
  ["completed-game persistence", /completedGames: completedGameHistory\.slice\(0, 12\)/],
  ["AI completed-game recording", /function recordCoachGameResult[\s\S]*?recordCompletedGame\(/],
  ["online completed-game recording", /remote\.status === "completed"[\s\S]*?recordCompletedGame\(/],
  ["header rating binding", /data-profile-field="gameRating"/],
  ["visible desktop profile metadata", /\.player-flex-chip > \.player-flex-main:last-child\s*\{\s*display: grid;/],
  ["player-card coins binding", /data-match-coins/],
  ["board-dominant player-card stack", /grid-template-areas:\s*\n\s*"setup"\s*\n\s*"opponent"\s*\n\s*"board"\s*\n\s*"player"\s*\n\s*"actions"\s*\n\s*"options"/],
  ["viewport-balanced board sizing", /--cq-play-board-max: min\(760px, max\(420px, calc\(100svh - var\(--cq-play-stage-chrome\)\)\)\);/],
  ["compact player-strip grid", /"avatar identity clock details"\s*\n\s*"footer footer footer details"/],
  ["live move context priority", /#play \.move-history \{\s*order: 1;/],
  ["collapsible move history", /id="moveHistoryDrawer"[\s\S]*?data-play-drawer="moves"[\s\S]*?id="moveHistory"/],
  ["collapsible coach tools", /id="coachToolsDrawer"[\s\S]*?data-play-drawer="coach"/],
  ["collapsible friend chat", /id="friendGameChatDrawer"[\s\S]*?data-play-drawer="chat"[\s\S]*?id="friendGameChat"/],
  ["responsive drawer defaults", /function setupPlayWorkspaceDrawers\([\s\S]*?drawer\.dataset\.playDrawer === "moves" \|\| !compactWorkspace/],
  ["friend chat drawer visibility", /function renderFriendGameChat[\s\S]*?drawer\.hidden = !enabled/],
  ["visible player-strip essentials", /match-player-meta :is\(\[data-match-side\], \[data-match-rating\], \[data-match-coins\], \[data-match-online\]\)[\s\S]*?display: inline-flex/],
  ["captured-piece presentation", /#play \.captured-pieces \{\s*display: flex;/],
  ["active move emphasis", /#play \.move-pair:last-child \{\s*border-color:/],
  ["play preference controls", /id="prefTheme"[\s\S]*?id="prefPressure"/],
  ["play preference bindings", /function setupLearnerPreferences\([\s\S]*?field\.addEventListener\("change"/],
  ["mobile player-card breakpoint", /@media \(max-width: 480px\)[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\) max-content/]
];

for (const [label, pattern] of requiredRegressionContracts) {
  if (!pattern.test(html)) throw new Error(`Missing regression contract: ${label}.`);
}

console.log("Site structure and inline application syntax verified.");
