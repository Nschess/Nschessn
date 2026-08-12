const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const appCssPath = "assets/app.css";
const appScriptPath = "assets/app.js";
const serviceWorkerPath = "service-worker.js";
if (!fs.existsSync(appCssPath) || !fs.existsSync(appScriptPath)) throw new Error("Missing cacheable application assets.");
const appCss = fs.readFileSync(appCssPath, "utf8");
const appScript = fs.readFileSync(appScriptPath, "utf8");
const serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");
if (/#play\.is-review-mode/.test(appCss)) throw new Error("Game Review CSS must not target the shared Play workspace.");
if (!/<link[^>]+href=["']assets\/app\.css(?:\?[^"']*)?["'][^>]*>/i.test(html)) throw new Error("Missing external application stylesheet link.");
if (!/<script\b[^>]*\bsrc=["']assets\/app\.js(?:\?[^"']*)?["'][^>]*><\/script>/i.test(html)) throw new Error("Missing external application script link.");
if (/<script>([\s\S]*?)<\/script>/i.test(html)) throw new Error("The application script must not remain inline.");
new Function(appScript);
const regressionSource = `${html}\n${appCss}\n${appScript}\n${serviceWorker}`;
const manifest = JSON.parse(fs.readFileSync("site.webmanifest", "utf8"));
if (
  manifest.id !== "./"
  || manifest.start_url !== "./"
  || manifest.scope !== "./"
  || manifest.display !== "standalone"
  || !manifest.theme_color
  || !manifest.background_color
  || !Array.isArray(manifest.icons)
) {
  throw new Error("The web manifest is missing a required TWA/PWA property.");
}

const requiredPngIcons = [
  ["assets/icons/icon-192.png", "192x192"],
  ["assets/icons/icon-512.png", "512x512"]
];
for (const [src, sizes] of requiredPngIcons) {
  const icon = manifest.icons.find((candidate) => candidate.src === src && candidate.sizes === sizes && candidate.type === "image/png");
  if (!icon || !fs.existsSync(src)) {
    throw new Error(`Missing required PWA icon: ${src}.`);
  }

  const png = fs.readFileSync(src);
  const expectedSize = Number.parseInt(sizes, 10);
  const isPng = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!isPng || width !== expectedSize || height !== expectedSize) {
    throw new Error(`PWA icon ${src} must be a ${sizes} PNG.`);
  }
}
const requiredMetadata = ["description", "robots", "theme-color", "og:title", "og:description"];
for (const name of requiredMetadata) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["']`, "i");
  if (!pattern.test(regressionSource)) throw new Error(`Missing required metadata: ${name}.`);
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

const prohibitedStaticMarkup = [
  ["legacy Play preference panel", /\bid="learnerPreferences"/],
  ["legacy direct preference controls", /\bid="pref(?:Theme|Coords|BoardScale|BoardBorder|Speed|Motion|Contrast|Pressure)"/]
];
for (const [label, pattern] of prohibitedStaticMarkup) {
  if (pattern.test(html)) throw new Error("Forbidden legacy markup: " + label + ".");
}
const aiRoster = [...appScript.matchAll(/\["(bot-[^"]+)",\s*"[^"]+",\s*(?:"[^"]+",\s*)?(\d{3,4}),/g)]
  .map((match) => ({ id: match[1], elo: Number(match[2]) }));
if (!aiRoster.length) throw new Error("Missing AI roster entries.");
const expectedAiBotConfigs = aiRoster.map((bot) => ({
  ...bot,
  skill: Math.max(0, Math.min(20, Math.round((bot.elo - 200) / 130))),
  depth: Math.max(1, Math.min(15, Math.ceil((bot.elo - 100) / 200))),
  movetime: Math.max(45, Math.min(3000, 45 + Math.round((bot.elo - 200) * 1.1))),
  uciElo: Math.max(1320, Math.min(3190, bot.elo)),
  fallback: bot.elo >= 2400 ? "strong" : "responsive"
}));
if (expectedAiBotConfigs.some((config) => !Number.isInteger(config.skill) || !Number.isInteger(config.depth) || !Number.isInteger(config.movetime) || !Number.isInteger(config.uciElo))) {
  throw new Error("AI roster runtime profile derivation failed.");
}
const protectedHighEloBots = expectedAiBotConfigs.filter((config) => config.elo >= 2460 && config.elo <= 2800);
if (protectedHighEloBots.length !== 5 || protectedHighEloBots.some((config) => config.fallback !== "strong" || config.skill < 17 || config.uciElo < 2460)) {
  throw new Error("High-Elo AI bots must retain strong fallback profiles.");
}
if (expectedAiBotConfigs.filter((config) => config.elo < 2400).some((config) => config.fallback !== "responsive")) {
  throw new Error("Lower-rated AI bots must retain responsive fallback profiles.");
}

const requiredRegressionContracts = [
  ["homepage top-player target", /id="homeTopPlayers"/],
  ["homepage rankings renderer", /function renderHomeTopPlayers\(entries = buildLeaderboardEntries\("ai"\)\)/],
  ["homepage rankings startup priming", /function primeHomeRankings\(\) \{[\s\S]*?hydrateSharedLeaderboardSnapshot\(\);[\s\S]*?renderHomeTopPlayers\(\);[\s\S]*?ensureSharedLeaderboardSync\(\);/],
  ["homepage rankings snapshot cache", /const leaderboardSnapshotStorageKey = "checkmateQuest\.leaderboardSnapshot\.v1";[\s\S]*?function cacheSharedLeaderboardSnapshot\(/],
  ["startup session detection", /setupSiteTabs\(\);\s*(?:setupAudioSystem\(\);\s*)?primeHomeRankings\(\);\s*void setupSupabaseAuthUi\(\);/],
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
  ["settings-owned gameplay preferences", /data-settings-page="gameplay"[\s\S]*?data-pref-setting="boardScale"[\s\S]*?data-pref-setting="boardBorder"/],
  ["settings-owned appearance preferences", /data-settings-page="appearance"[\s\S]*?data-pref-setting="theme"[\s\S]*?data-pref-setting="backgroundTheme"/],
  ["shared settings preference binding", /function applySettingsPrefsPatch\(patch, label = "settings"\) \{[\s\S]*?normalizedPatch\.boardScale[\s\S]*?shell\.addEventListener\("input"[\s\S]*?prefKey === "boardScale"/],
  ["light-mode inline surface reset", /function applyBackgroundTheme\(value\) \{[\s\S]*?themeSurfaceProperties[\s\S]*?classList\.contains\("theme-light"\)[\s\S]*?style\.removeProperty\(property\)/],
  ["light-mode active-panel preservation", /function applyLearnerPrefs\(prefs\) \{[\s\S]*?const activePanel = document\.querySelector\("main > \.site-panel\.is-active-panel"\);[\s\S]*?activePanel\.hidden = false/],
  ["mobile player-card breakpoint", /@media \(max-width: 480px\)[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\) max-content/],
  ["human-readable board labels", /const accessiblePieceNames[\s\S]*?function getAccessibleSquareLabel\(/],
  ["board keyboard focus retention", /function getFocusedBoardSquare\([\s\S]*?function restoreBoardFocus\([\s\S]*?function renderTutorialBoard\([\s\S]*?restoreBoardFocus\(board, focusedSquareName\)[\s\S]*?function renderPuzzleBoard\([\s\S]*?restoreBoardFocus\(board, focusedSquareName\)/],
  ["board group semantics", /id="tutorialBoard" role="group" aria-roledescription="chess board"[\s\S]*?id="coachBoard" role="group"[\s\S]*?id="puzzleBoard" role="group"[\s\S]*?id="realPuzzleBoard" role="group"/],
  ["live puzzle feedback", /id="feedback" role="status" aria-live="polite" aria-atomic="true"[\s\S]*?id="realPuzzleFeedback" role="status" aria-live="polite" aria-atomic="true"/],
  ["player pass dashboard layout", /Player Pass dashboard:[\s\S]*?#login \.login-shell \{[\s\S]*?grid-template-columns: minmax\(340px, 1\.2fr\) minmax\(318px, 0\.98fr\) minmax\(292px, 0\.9fr\);/],
  ["player pass dashboard preservation", /#login \.login-pass \{[\s\S]*?display: contents;[\s\S]*?#login \.login-pass-grid \{ display: contents; \}/],
  ["player pass compact breakpoint", /@media \(max-width: 760px\) \{[\s\S]*?#login \.login-shell \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: none; \}/],
  ["profile stats first", /grid-template-areas:\s*\n\s*"overview"\s*\n\s*"stats"\s*\n\s*"ratings"\s*\n\s*"progress"/],
  ["premium daily session", /id="homeSessionCard"[\s\S]*?id="homeSessionAction"[\s\S]*?id="homeSessionWhy"/],
  ["homepage daily command deck", /class="hero hero-command-center home-command-deck"[\s\S]*?home-command-session[\s\S]*?hero-quick-card--learn[\s\S]*?class="home-command-secondary"[\s\S]*?home-command-secondary-grid/],
  ["Chess DNA dashboard", /id="homeDnaTitle"[\s\S]*?id="homeDnaSkills"[\s\S]*?id="homeDnaAction"/],
  ["focused onboarding duration", /id="firstVisitSession" name="sessionMinutes"[\s\S]*?sessionMinutes: String\(data\.get\("sessionMinutes"\)/],
  ["one-moment review loop", /id="reviewOneMoment"[\s\S]*?id="reviewOneMomentPractice"[\s\S]*?function practiceReviewOneMoment\(/],
  ["review self-analysis workspace", /id="reviewSelfAnalysis"[\s\S]*?id="reviewSelfAnalysisLine"[\s\S]*?id="reviewSelfAnalysisEngineLine"[\s\S]*?id="reviewSelfAnalyze"[\s\S]*?id="reviewSelfUndo"[\s\S]*?id="reviewSelfCopy"[\s\S]*?function startReviewSelfAnalysis\([\s\S]*?function undoReviewSelfAnalysisMove\([\s\S]*?function getReviewSelfAnalysisPgn\([\s\S]*?function copyReviewSelfAnalysis\([\s\S]*?function formatReviewSelfAnalysisPrincipalVariation\([\s\S]*?function analyzeReviewSelfPosition\([\s\S]*?function makeReviewSelfAnalysisMove\(/],
  ["dedicated Game Review workspace", /id="gameReview"[\s\S]*?id="gameReviewWorkspace"[\s\S]*?class="game-review-shell"[\s\S]*?function mountGameReviewWorkspace\([\s\S]*?playWorkspace\?\.setAttribute\("inert", ""\)[\s\S]*?workspace\.removeAttribute\("hidden"\)[\s\S]*?function restoreGameReviewWorkspace\([\s\S]*?workspace\.setAttribute\("hidden", ""\)/],
  ["board-first review command center structure", /id="reviewHeaderSlot"[\s\S]*?id="reviewSummarySlot"[\s\S]*?class="game-review-command-center"[\s\S]*?class="game-review-analysis-slot"[\s\S]*?id="reviewCoachSlot"[\s\S]*?id="reviewDock"[\s\S]*?data-review-dock-tab="timeline"[\s\S]*?id="reviewMoveHistorySlot"[\s\S]*?id="reviewImprovementSlot"/],
  ["review workspace isolation", /#top:has\(> #gameReview\.is-review-page\) > :not\(#gameReview\)[\s\S]*?document\.body\.classList\.add\("is-game-review-active"\)[\s\S]*?document\.body\.classList\.remove\("is-game-review-active"\)/],
  ["review dashboard responsive bounds", /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)[\s\S]*?#reviewMoveHistorySlot #moveHistory \{\s*max-height: 154px;[\s\S]*?@media \(max-width: 840px\)[\s\S]*?@media \(max-width: 520px\)[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/],
  ["review analysis states", /review-state-loading::after[\s\S]*?review-state-error/],
  ["live engine withheld until review", /id="enginePanel"[\s\S]*?#play #enginePanel\s*\{[\s\S]*?display: none !important;[\s\S]*?function updateEnginePanel\([\s\S]*?panel\.hidden = true;/],
  ["post-game review decision", /id="postGameDecision"[\s\S]*?id="postGameDecisionReview"[\s\S]*?id="postGameDecisionNew"[\s\S]*?id="postGameDecisionClose"[\s\S]*?function showPostGameDecision\([\s\S]*?postGameDecisionPgn[\s\S]*?postGameDecisionClose"\)\?\.addEventListener/],
  ["post-game review terminal flow", /id="postGameDecision"[\s\S]*?id="postGameDecisionReview"[\s\S]*?function completeCoachGame\([\s\S]*?cancelStockfishSearch\("Game ended"\)[\s\S]*?configurePostGameDecisionActions\(outcome\)[\s\S]*?showPostGameDecision\(\)[\s\S]*?function openPostGameReview\([\s\S]*?mountGameReviewWorkspace\(/],
  ["saved review route recovery", /function activateSiteTab\(config, shouldScroll = true\) \{[\s\S]*?config\.panel === "gameReview"[\s\S]*?const savedReview = matchReviews\.find\(\(review\) => review\?\.moves\?\.length && review\?\.summary\)[\s\S]*?initializeDeferredFeature\("play"\)\.then\(\(\) => \{[\s\S]*?isGameReviewRoute\(\)[\s\S]*?openSavedMatchReview\(savedReview\)/],
  ["configurable review analysis profile", /function getReviewAnalysisConfig\(mode = "quick"\) \{[\s\S]*?const deep = mode === "deep";[\s\S]*?skill: deep \? \(lowPerformance \? 14 : 18\) : lowPerformance \? 6 : 10,[\s\S]*?depth: deep \? \(lowPerformance \? 7 : 10\) : lowPerformance \? 3 : 5,[\s\S]*?reviewMode: deep \? "deep" : "quick"/],
  ["deep review timeout recovery", /function getReviewAnalysisTimeoutMs\([\s\S]*?function showReviewAnalysisError\([\s\S]*?panel\?\.removeAttribute\("aria-busy"\)[\s\S]*?showReviewAnalysisError\(token, `\$\{label\} stopped waiting for Stockfish\. Try again to restart the engine\.`\)/],
  ["review cancellation and focus return", /function cancelActiveReviewAnalysis\([\s\S]*?cancelStockfishSearch\(reason\)[\s\S]*?function exitGameReview\([\s\S]*?renderPostGameFlow\(true\)[\s\S]*?postGameDecisionReview"\) \|\| returnFocus/],
  ["review growth trail", /id="reviewGrowthTrail"[\s\S]*?id="reviewGrowthHabit"[\s\S]*?function renderReviewGrowthTrail\([\s\S]*?Repair next:/],
  ["advanced self-analysis tools", /id="reviewSelfEngineEnabled"[\s\S]*?id="reviewSelfEngineMode"[\s\S]*?id="reviewSelfOpeningRefresh"[\s\S]*?id="reviewSelfTablebaseCheck"[\s\S]*?function lookupReviewSelfOpening\([\s\S]*?explorer\.lichess\.org[\s\S]*?function lookupReviewSelfTablebase\([\s\S]*?tablebase\.lichess\.ovh/],
  ["review keyboard access", /id="reviewCurrentMoveStatus"[\s\S]*?event\.key === "Escape"[\s\S]*?event\.key\.toLowerCase\(\) === "z"/],
  ["local-only product signals", /const productSignalsStorageKey = "nschess\.productSignals\.v1";[\s\S]*?function trackProductSignal\(/],
  ["premium home renderer", /function renderPremiumHomeExperience\([\s\S]*?renderPremiumHomeExperience\(\{ focus, focusPuzzlePlan, nextStep, latestReadyReview \}\);/],
  ["daily ritual progress loop", /id="homeSessionRitual"[\s\S]*?function renderPremiumHomeExperience\([\s\S]*?daily_ritual_opened/],
  ["visible daily ritual reward", /id="homeSessionReward"[\s\S]*?id="homeSessionClaim"[\s\S]*?action === "claim-daily-ritual"[\s\S]*?claimDailyGoalsReward\(/],
  ["weekly momentum runway", /id="homeMomentumTitle"[\s\S]*?id="homeMomentumMeter"[\s\S]*?id="homeMomentumDays"[\s\S]*?function getWeeklyMomentumDays\(/],
  ["next unlock milestone", /id="homeMomentumMilestone"[\s\S]*?id="homeMomentumMilestoneTitle"[\s\S]*?function getNextAchievementMilestone\([\s\S]*?function setPremiumHomeMilestone\(/],
  ["active coach tone", /data-profile-setting="coachTone"[\s\S]*?function getCoachTone\([\s\S]*?function getPremiumSessionVoice\([\s\S]*?function getPremiumMomentumCopy\(/],
  ["premium home reduced motion", /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.home-session-ritual-item[\s\S]*?\.home-momentum-milestone[\s\S]*?\.home-momentum-meter span/],
  ["cacheable application asset split", /href="assets\/app\.css(?:\?v=[^"]+)?"[\s\S]*?src="assets\/app\.js(?:\?v=[^"]+)?"/],
  ["offline shell application cache", /const CACHE_NAME = "nschess-shell-v\d+-[^"]+";[\s\S]*?"\.\/assets\/app\.css\?v=review-v\d+-[^"]+"[\s\S]*?"\.\/assets\/app\.js\?v=review-v\d+-[^"]+"[\s\S]*?isReviewShellAsset/],
  ["friend challenge create and join tabs", /id="friendCreateTab"[\s\S]*?aria-controls="friendCreatePanel"[\s\S]*?id="friendJoinTab"[\s\S]*?aria-controls="friendJoinPanel"/],
  ["friend challenge valid default clock", /function normalizeFriendChallengeClock\(value\)[\s\S]*?"5\+0"[\s\S]*?function getFriendInviteLink\([\s\S]*?clock: source\.clock/],
  ["friend challenge quick time controls", /id="friendClockPresets"[\s\S]*?data-friend-clock="3\+2"[\s\S]*?data-friend-clock="5\+0"[\s\S]*?data-friend-clock="10\+0"/],
  ["friend challenge full join code", /id="friendJoinCode" maxlength="10"[\s\S]*?function joinFriendChallengeCode\([\s\S]*?slice\(0, 10\)/],
  ["friend challenge result-first sharing", /const shareReady = Boolean\(state\.remote[\s\S]*?link\.disabled = !shareReady[\s\S]*?primary\.textContent = !state\.remote \? "Create invite"/],
  ["friend challenge accessible panel switcher", /function setFriendChallengeLobbyView\([\s\S]*?createPanel\.hidden[\s\S]*?joinPanel\.hidden[\s\S]*?aria-selected/],
  ["quick match provider queue methods", /joinMatchmakingQueue:\s*\(options = \{\}\) => callFriendRpc\("join_matchmaking_queue"/],
  ["quick match provider status methods", /getMatchmakingStatus:\s*\(ticketId\) => callFriendRpc\("get_matchmaking_status"/],
  ["quick match provider leave methods", /leaveMatchmakingQueue:\s*\(ticketId\) => callFriendRpc\("leave_matchmaking_queue"/],
  ["quick match online adapter", /function setupOnlineMatchmakingAdapter\([\s\S]*?window\.NschessOnlineMatchmaking = \{[\s\S]*?findMatch\([\s\S]*?getFriendProvider\(\)[\s\S]*?startMatch\([\s\S]*?getFriendChallenge\([\s\S]*?startFriendChallenge\(false\)/],
  ["quick match auth gate", /function setupQuickMatch\([\s\S]*?canUseOnlineQuickMatch[\s\S]*?Sign in with your Player Pass to use Quick Match/],
  ["global premium design foundation", /Premium redesign: global experience layer[\s\S]*?--cq-content-max:[\s\S]*?--cq-section-space:[\s\S]*?--cq-ease-premium:/],
  ["premium light-mode parity", /body\.theme-light \{[\s\S]*?--cq-bg-primary: #eef3fb;[\s\S]*?--cq-text-primary: #18233d;[\s\S]*?body\.theme-light::before/],
  ["premium cross-page section rhythm", /main > :is\(\.section-dark, \.section-warm\)[\s\S]*?padding-block: var\(--cq-section-space\)[\s\S]*?\.wrap \{[\s\S]*?var\(--cq-content-max\)/],
  ["cross-page layout cohesion", /Cohesive layout refinement:[\s\S]*?\.home-main-grid[\s\S]*?#play:not\(\.is-review-mode\) \.play-shell[\s\S]*?#gameReview\.is-review-page \.premium-review[\s\S]*?@media \(max-width: 920px\)[\s\S]*?@media \(prefers-reduced-motion: reduce\)/],
  ["premium navigation shell", /Premium redesign: persistent navigation and workspace shell finish[\s\S]*?\.mobile-bottom-nav[\s\S]*?var\(--cq-surface-glass-strong\)/],
  ["premium motion and accessibility safeguards", /Premium redesign: interaction quality, accessibility, and motion restraint[\s\S]*?@media \(prefers-contrast: more\)[\s\S]*?@media \(forced-colors: active\)[\s\S]*?@media \(prefers-reduced-motion: reduce\)/],
  ["deferred video embeds", /<iframe loading="lazy" data-src="https:\/\/www\.youtube-nocookie\.com\/embed\/[\s\S]*?function setupVideoTheater\([\s\S]*?iframe\.dataset\.src \|\| iframe\.getAttribute\("src"\)[\s\S]*?if \(!src\) return;/],
  ["video modal watch fallback", /id="videoOpenExternal"[\s\S]*?function buildVideoWatchUrl\([\s\S]*?externalLink\.href = watchUrl/],
  ["AI roster strength mapping", /beginnerBots\.forEach\(\(bot, index\) => \{[\s\S]*?bot\.skill = Math\.max\(0, Math\.min\(20, Math\.round\(\(bot\.elo - 200\) \/ 130\)\)\);[\s\S]*?bot\.depth = Math\.max\(1, Math\.min\(15, Math\.ceil\(\(bot\.elo - 100\) \/ 200\)\)\);[\s\S]*?bot\.movetime = Math\.max\(45, Math\.min\(3000, 45 \+ Math\.round\(\(bot\.elo - 200\) \* 1\.1\)\)\);[\s\S]*?function setCoachDifficulty\(level\) \{[\s\S]*?stockfishLevels\[level\] \|\| getBeginnerBot\(level\)[\s\S]*?function getCoachConfig\(level = coachDifficulty\) \{[\s\S]*?const bot = getBeginnerBot\(level\);[\s\S]*?label: bot\.name \+ " engine",[\s\S]*?uciElo: elo/],
  ["AI roster high-strength fallback boundary", /function getCoachSkill\(\) \{\s*return Number\(getCoachConfig\(\)\.skill\) \|\| 0;[\s\S]*?function usesHighStrengthCoachFallback\(config = getCoachConfig\(\)\) \{[\s\S]*?getBeginnerBot\(coachDifficulty\)[\s\S]*?Number\(config\.elo\) >= 2400[\s\S]*?function getReliableCoachFallback\([\s\S]*?usesHighStrengthCoachFallback\(config\)[\s\S]*?chooseStrongCoachMove\(moves\)[\s\S]*?: chooseResponsiveCoachFallback\(moves\)/],
  ["narrow video modal action bar", /\.video-modal-title \{[\s\S]*?min-width: 0;[\s\S]*?text-overflow: ellipsis;[\s\S]*?\.video-modal-actions \{[\s\S]*?flex: 0 0 auto;[\s\S]*?@media \(max-width: 420px\) \{[\s\S]*?\.video-modal \{[\s\S]*?padding: 12px;/],
  ["profile rating-history disclosure", /<details class="profile-optional-detail">[\s\S]*?data-profile-history-status[\s\S]*?data-profile-rating-history/],
  ["Game Review restores every mounted source", /function restoreGameReviewWorkspace\([\s\S]*?\[\.\.\.origins\.values\(\)\]\.reverse\(\)\.forEach/],
  ["stable real-puzzle square rendering", /const pieceKey = piece[\s\S]*?\$\{pieceSvgRenderVersion\}:\$\{activePieceSvgSet\}:\$\{piece\.color\}\$\{piece\.type\}/],
  ["post-game decision remains an overlay", /function getPostGameDecisionDialog\(\) \{\s*return document\.getElementById\("postGameDecision"\);\s*\}/]
];

const prohibitedReviewLeaks = [
  ["eager Game Review DOM staging", /stageReviewSourcesForLivePlay|gameReviewStaging/],
  ["review-owned normal Play layout override", /Review sources are staged outside #play|Live Play keeps only the chess session/]
];

for (const [label, pattern] of prohibitedReviewLeaks) {
  if (pattern.test(regressionSource)) throw new Error(`Forbidden Game Review leak: ${label}.`);
}

for (const [label, pattern] of requiredRegressionContracts) {
  if (!pattern.test(regressionSource)) throw new Error(`Missing regression contract: ${label}.`);
}

console.log("Site structure and inline application syntax verified.");
