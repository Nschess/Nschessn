/*
 * Static regression contracts for the shared board interaction lifecycle.
 *
 * The browser harness owns pointer/touch execution; this script protects the
 * architecture that makes those paths safe across route changes and cache
 * updates without duplicating the application runtime in Node.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("assets/app.js");
const css = read("assets/app.css");
const openingsCss = read("assets/routes/openings.css");
const perfLiteCss = read("assets/routes/perf-lite.css");
const html = read("index.html");
const worker = read("service-worker.js");
const deployment = read("docs/DEPLOYMENT-CHECKLIST.md");
const pianoMigration = read("supabase/migrations/20260819_premium_piano_store.sql");

const requiredAppContracts = [
  ["one-registration map", /const registrations = new WeakMap\(\)/],
  ["active registration set", /const activeRegistrations = new Set\(\)/],
  ["board-scoped cancellation API", /cancel\(board, event = null\) \{ registrations\.get\(board\)\?\.cancel\(event\); \}/],
  ["idle ghost cancellation", /cancel\(event = null\) \{[\s\S]*?state\.pointerId === null && state\.phase === boardInteractionPhases\.IDLE[\s\S]*?cleanupInteraction\(event\)/],
  ["shared idempotent cleanup", /const cleanupInteraction = \(event = null,[\s\S]*?state\.cleanupInProgress[\s\S]*?board\.querySelectorAll\("\.dragging"\)[\s\S]*?clearGhost\(\)[\s\S]*?releasePointer\(event\)/],
  ["detach uses shared cleanup", /detach\(\) \{[\s\S]*?cleanupInteraction\(\{ pointerId: state\.pointerId, type: "detach" \},[\s\S]*?notifyCancel:/],
  ["lost pointer capture cleanup", /const onLostPointerCapture = \(event\) =>[\s\S]*?type: "lostpointercapture"[\s\S]*?abortActivePointer/],
  ["route cancellation API", /cancelAll\(event = null\)/],
  ["route cancellation call", /boardInteractionEngine\.cancelAll\(\{ type: "routechange" \}\)/],
  ["drag safety timer", /dragSafetyTimer/],
  ["blur cleanup", /window\.addEventListener\("blur", onWindowBlur\)/],
  ["visibility cleanup", /document\.addEventListener\("visibilitychange", onVisibilityChange\)/],
  ["Escape shared release", /shared finalizer so Escape follows the same release path/],
  ["Adventure square identity", /square\.dataset\.square = name/],
  ["Play analysis opt-in", /return reviewPageActive \|\| !liveFriendGame/],
  ["Play overlay preservation", /controller\?\.render\(\[\], \[\]\)/],
  ["shared manual-arrow cleanup helper", /function clearAnalysisArrows\(reason = "manual-cleanup", board = null\)[\s\S]*?clearUserArrows\?\.\(reason\)/],
  ["position-scoped manual arrows", /function getAnalysisBoardPositionKey\(board\)[\s\S]*?clearAnalysisArrows\("position-change", board\)/],
  ["Play move annotation helper", /function clearCoachTemporaryAnalysis\(\)[\s\S]*?clearAnalysisArrows\("move-commit", board\)/],
  ["Committed move annotation clear", /function makeCoachMove\([\s\S]*?if \(!move\) \{[\s\S]*?return false;\s*\}\s*\n\s*clearCoachTemporaryAnalysis\(\);/],
  ["Bot move annotation clear", /const move = safeReply && coachGame\.move\([\s\S]*?if \(move\) \{\s*clearCoachTemporaryAnalysis\(\);/],
  ["Premove turn guard", /function queueCoachPremove\(from, to = ""\)[\s\S]*?coachGame\.turn\(\) === coachPlayerColor\) return false/],
  ["Premove conservative default", /const fallback = \{[\s\S]*?premove: "off"/],
  ["Premove preference gate", /function isLivePremoveEnabled\(\)[\s\S]*?livePremovePreference === "on"[\s\S]*?friendChallengeState\?\.remote/],
  ["Premove preference hydration", /function applyLearnerPrefs\(prefs\)[\s\S]*?livePremovePreference = prefs\.premove === "on" \? "on" : "off"/],
  ["Premove setting rerenders board", /function preferencesRequireBoardRender\(changedPreferences\)[\s\S]*?key === "premove"/],
  ["Premove human opponent gate", /function isLivePremoveEnabled\(\)[\s\S]*?friendChallengeState\.opponentId/],
  ["AI fallback premove isolation", /function resetRealtimeContextForAi\(\)[\s\S]*?remote: false/],
  ["Quick Match human handoff", /async startMatch\(match\)[\s\S]*?applyRemoteFriendChallenge\(remote, true\)/],
  ["Disabled setting cancels queue", /function applySettingsPrefsPatch\([\s\S]*?normalizedPatch\.premove === "off"[\s\S]*?cancelCoachPremove/],
  ["Premove revalidation", /function tryRunCoachPremove\(\)[\s\S]*?moves\(\{ square: queued\.from, verbose: true \}\)/],
  ["Remote premove wake-up", /const remotePositionChanged = Boolean\([\s\S]*?const canCheckPremove = remote\.status === "active"[\s\S]*?tryRunCoachPremove\(\)/],
  ["Idle lifecycle premove cleanup", /onLifecycleCancel\(\)[\s\S]*?isLivePremoveEnabled\(\)[\s\S]*?cancelCoachPremove\(\)/],
  ["Route premove cleanup", /boardInteractionEngine\.cancelAll\(\{ type: "routechange" \}\);\s*cancelCoachPremove\(\);/],
  ["Opening render cancels active drag", /function renderOpeningExplorerBoard\(\{ skipInteractionCancel = false \} = \{\}[\s\S]*?interactionState\.phase === boardInteractionPhases\.DRAGGING \|\| interactionState\.ghost[\s\S]*?boardInteractionEngine\.cancel\(board, \{ type: "opening-render" \}\)/],
  ["Opening cancel restores authoritative pieces", /onCancel\(source, event, state\)[\s\S]*?renderOpeningExplorerBoard\(\{ skipInteractionCancel: true \}\)/],
  ["Opening audio uses composed-path guard", /const isOpeningExplorerBoardEvent = \(event\)[\s\S]*?event\.composedPath\(\)[\s\S]*?opening-explorer-board, \.opening-explorer-square/],
  ["Pointer discovery does not start ambient audio", /const unlockAudio = \(\) => audioManager\.unlock\(\{ autoStartMusic: false \}\)/],
  ["Intentional click only unlocks audio", /document\.addEventListener\("click", \(event\) =>[\s\S]*?audioManager\.unlock\(\{ autoStartMusic: false \}\)[\s\S]*?playAudioCue\(cue\)/],
  ["Legacy WebAudio music is retired", /function startAudioMusic\([\s\S]*?Legacy WebAudio themes[\s\S]*?audioRuntime\.playing = false[\s\S]*?return false;/],
  ["Opening clicks stay silent", /target\.closest\("\.play-board-wrap, \.play-board, \.play-square, \.piece-symbol, \.piece-svg, \.puzzle-square, \.opening-explorer-board, \.opening-explorer-square, \.answer-button"\)/],
  ["UI activation keeps click sound path", /document\.addEventListener\("click", \(event\) =>[\s\S]*?target\?\.closest\("button, a, summary"\)[\s\S]*?playAudioCue\(cue\)/],
  ["Store ambience is opt-in", /storeAmbience: false/],
  ["Store ambience uses curated piano tracks", /const premiumPianoTracks = Object\.freeze[\s\S]*?quiet-calculation[\s\S]*?rising-position[\s\S]*?midnight-strategy[\s\S]*?beyond-the-board[\s\S]*?subtle-triumph/],
  ["Retired Store music is explicit", /const retiredStoreMusicValues = new Set\(\[[\s\S]*?after-last-move[\s\S]*?quiet-strategy[\s\S]*?golden-endgame/],
  ["Retired persisted music is migrated", /const savedMusicPack = String\(prefs\.audio\.musicPack[\s\S]*?retiredStoreMusicState[\s\S]*?prefs\.audio\.musicPack = "calm"[\s\S]*?prefs\.audio\.playing = false[\s\S]*?prefs\.audio\.storeAmbience = false[\s\S]*?writeJsonStorage\(learnerPrefsStorageKey, prefs\)/],
  ["Retired equipped Store IDs are normalized", /function normalizeStoreState\(saved = \{\}\)[\s\S]*?const equipped = saved\?\.equipped[\s\S]*?item\.type === type[\s\S]*?item\.type !== "flexBadge"/],
  ["Legacy audio elements are removed", /function cleanupLegacyAudioElements\(\)[\s\S]*?document\.querySelectorAll\("audio"\)[\s\S]*?element\.remove\(\)/],
  ["Retired audio source is stopped", /function stopRetiredPremiumAudio\(\)[\s\S]*?isRetiredStoreAudioSource[\s\S]*?clearPremiumAudioElement\(element\)[\s\S]*?audioRuntime\.premiumTrackId = ""/],
  ["Stop clears orphaned shared source", /function stopAudioMusic\(save = true\)[\s\S]*?else if \(audioRuntime\.premiumAudio\) clearPremiumAudioElement\(audioRuntime\.premiumAudio\)/],
  ["Store catalog retires sound packs", /const audioSfxStoreItems = \[\];[\s\S]*?const storeItems = \[[\s\S]*?\.\.\.audioMusicStoreItems,[\s\S]*?\.\.\.boardThemeStoreItems/],
  ["Store ambience uses local audio renderer", /function startStoreAmbience\(\)[\s\S]*?startPremiumTrack\(equipped, \{ mode: "store", loop: true/],
  ["Premium preview uses one shared element", /function startPremiumTrack\([\s\S]*?audioRuntime\.premiumAudio[\s\S]*?stopPremiumTrack/],
  ["Premium preview eagerly loads the recording", /function ensurePremiumAudio\([\s\S]*?element\.preload = "auto"[\s\S]*?function startPremiumTrack\([\s\S]*?element\.src = track\.audioUrl;[\s\S]*?element\.load\(\);[\s\S]*?element\.play\(\)/],
  ["Preview volume is independent of game music opt-out", /function applyPremiumAudioVolume\([\s\S]*?const previewActive = audioRuntime\.premiumTrackMode === "preview"[\s\S]*?audio\.ambientEnabled === false[\s\S]*?!previewActive && audio\.backgroundMusic === false/],
  ["Game music opt-out stops active tracks", /function writeAudioPrefs\([\s\S]*?disablingGameMusic[\s\S]*?audioRuntime\.playing && !storePreviewState[\s\S]*?stopAudioMusic\(false\)/],
  ["Premium preview can be stopped", /function startStorePreview\([\s\S]*?storePreviewState\?\.item\?\.id === item\.id[\s\S]*?stopStorePreview/],
  ["Store ambience avoids route restarts", /function syncStoreAmbienceForRoute\(\)[\s\S]*?storeAmbienceActive/],
  ["Store route silences global legacy music", /function syncStoreAmbienceForRoute\(\)[\s\S]*?isStorePanelActive\(\)[\s\S]*?!storePreviewState[\s\S]*?audioRuntime\.playing \|\| audioRuntime\.premiumTrackId[\s\S]*?stopAudioMusic\(false\)/],
  ["Store ambience protects scene changes", /function setAudioScene\(scene = inferAudioScene\(\)\) \{\s*if \(audioRuntime\.storeAmbienceActive && isStorePanelActive\(\)\) return;/],
  ["Store ambience control persists preference", /storeAmbienceToggle[\s\S]*?writeAudioPrefs\(\{ storeAmbience: enabled \}\)/],
  ["Store authority has explicit auth state", /let storeAuthState = \{ status: "unknown", userId: "" \};/],
  ["Store authority resolves Supabase user", /async function getAuthoritativeStoreUser\(\)[\s\S]*?getAuthenticatedUserId\?\.\(\)[\s\S]*?setStoreAuthState\("authenticated"/],
  ["Store does not use Friends cache as authority", /function storeServerRequiresAuthority\(\)[\s\S]*?storeAuthState\.status !== "signed_out"/],
  ["Protected RPC validates Supabase user", /const callFriendRpc = async \(name, args = \{\}\) => \{[\s\S]*?supabase\.auth\.getUser\(\)[\s\S]*?supabase\.rpc\(name, args\)/],
  ["Purchase hydrates returned server balance", /const purchaseResult = await getAuthProvider\(\)\.purchaseCosmetic[\s\S]*?returnedCoins[\s\S]*?refreshServerStoreState\(\{ rerender: false \}\)/],
  ["Auth lifecycle updates Store authority", /function applyAuthenticatedAccount\(account\)[\s\S]*?setStoreAuthState\("signed_out"\)[\s\S]*?setStoreAuthState\("authenticated"/]
];
requiredAppContracts.forEach(([name, pattern]) => {
  assert.match(app, pattern, `Missing board lifecycle contract: ${name}`);
});
const openingInteractionBody = app.slice(app.indexOf("function handleOpeningExplorerSquare("), app.indexOf("function renderOpeningExplorerBoard("));
assert.doesNotMatch(openingInteractionBody, /playAudioCue\(/, "Opening Explorer board interaction must not dispatch audio directly");
const openingRenderBody = app.slice(app.indexOf("function renderOpeningExplorerBoard("), app.indexOf("function renderOpeningExplorerFavoriteState("));
assert.doesNotMatch(openingRenderBody, /playAudioCue\(/, "Opening Explorer board rendering must not dispatch audio");
const audioSetupBody = app.slice(app.indexOf("function setupAudioSystem("), app.indexOf("function animateCoinsToInventory("));
assert.doesNotMatch(audioSetupBody, /document\.addEventListener\("pointerover"/, "UI hover must not register a global audio listener");
assert.doesNotMatch(audioSetupBody, /playAudioCue\("hover"\)/, "UI hover must not dispatch an audio cue");
assert.match(audioSetupBody, /audioManager\.unlock\(\{ autoStartMusic: false \}\)/, "UI clicks must not auto-start global music");
assert.match(audioSetupBody, /isStorePanelActive\(\) && !storePreviewState && !audioRuntime\.storeAmbienceActive[\s\S]*?stopAudioMusic\(false\)/, "Store option clicks must stop stale global music");
assert.doesNotMatch(app, /function playMusicStep\(/, "Legacy looping WebAudio scheduler must not remain active");
assert.doesNotMatch(app, /playAudioCue\(\s*["']hover["']\s*\)/, "No hover cue may be dispatched anywhere in the application");
assert.doesNotMatch(app, /assets\/audio\/(?:after-the-last-move|quiet-strategy|golden-endgame)\.mp3/, "Retired Store audio paths must not be referenced by the runtime");
assert.doesNotMatch(app, /new\s+(?:window\.)?Audio\s*\(/, "Store playback must not create ad-hoc Audio instances");
assert.match(app, /let storeState = normalizeStoreState\(savedPuzzleState\.store\);[\s\S]*?JSON\.stringify\(savedPuzzleState\.store\?\.equipped \|\| \{\}\)[\s\S]*?writeJsonStorage\(puzzleStorageKey/, "Retired equipped Store IDs must be persisted out of puzzle state");
assert.doesNotMatch(audioSetupBody, /document\.addEventListener\("(?:pointerover|pointerenter|mouseover|mouseenter)"/, "Pointer hover must not register a global audio listener");
assert.match(html, /id="storeAmbienceToggle"/, "Store must expose an opt-in ambience control");
assert.match(html, /data-audio-setting="backgroundMusic"[\s\S]*?Music during games/, "Settings must expose an explicit in-game music preference");
assert.match(app, /audioUrl: "assets\/audio\/quiet-calculation\.mp3"[\s\S]*?license: "CC0 1\.0 Universal"/);
assert.match(app, /audioUrl: "assets\/audio\/rising-position\.mp3"[\s\S]*?license: "CC0 1\.0 Universal"/);
assert.match(app, /audioUrl: "assets\/audio\/midnight-strategy\.mp3"[\s\S]*?license: "CC0 1\.0 Universal"/);
assert.match(app, /audioUrl: "assets\/audio\/beyond-the-board\.mp3"[\s\S]*?license: "CC0 1\.0 Universal"/);
assert.match(app, /audioUrl: "assets\/audio\/subtle-triumph\.mp3"[\s\S]*?license: "CC0 1\.0 Universal"/);
["quiet-calculation.mp3", "rising-position.mp3", "midnight-strategy.mp3", "beyond-the-board.mp3", "subtle-triumph.mp3"].forEach((file) => {
  assert.ok(fs.existsSync(path.join(root, "assets", "audio", file)), `Missing bundled Store piano asset: ${file}`);
});
["after-the-last-move.mp3", "quiet-strategy.mp3", "golden-endgame.mp3"].forEach((file) => {
  assert.ok(!fs.existsSync(path.join(root, "assets", "audio", file)), `Retired Store piano asset remains bundled: ${file}`);
});
assert.match(pianoMigration, /music-quiet-calculation[\s\S]*?music-rising-position[\s\S]*?music-midnight-strategy[\s\S]*?music-beyond-the-board[\s\S]*?music-subtle-triumph[\s\S]*?CC0 1\.0 Universal/);
assert.match(pianoMigration, /music-after-last-move[\s\S]*?music-quiet-strategy[\s\S]*?music-golden-endgame/);
assert.doesNotMatch(audioSetupBody, /startAudioMusic\(inferAudioScene\(\), "store-lounge"/, "Store ambience must not be forced by global audio unlock");
assert.doesNotMatch(app, /finishGhost\(/, "Drag cleanup must not leave delayed ghost animation branches");
assert.match(app, /const puzzleFeedbackFrames = new WeakMap\(\);[\s\S]*?const puzzleFeedbackTimers = new WeakMap\(\);[\s\S]*?function flashPuzzleBoard\([\s\S]*?requestAnimationFrame\([\s\S]*?puzzleFeedbackTimers/, "Puzzle feedback must restart without a forced board reflow");
assert.doesNotMatch(app.slice(app.indexOf("function flashPuzzleBoard("), app.indexOf("function setPuzzleSolutionProgress(")), /offsetWidth/, "Puzzle feedback must not synchronously flush the board layout");
assert.match(css, /\.real-puzzle-square:is\(\.last-move, \.capture-impact, \.promotion-bloom, \.castle-impact, \.en-passant-impact\)[\s\S]*?animation:\s*none/, "Real puzzle pieces must not run a second CSS animation over board motion");
assert.match(app, /function animateBoardPieceTransition\(board, move, options = \{\}\)[\s\S]*?const fade = options\.fade !== false/, "Board motion must expose an explicit opacity-fade switch");
assert.match(app, /if \(animateEffect && realPuzzleLastMove\) animateBoardPieceTransition\(board, realPuzzleLastMove, \{ fade: false \}\)/, "Real puzzle motion must remain transform-only so correct pieces do not fade");
assert.match(css, /\.real-puzzle-square\.last-move\s*\{[\s\S]*?animation:\s*none !important[\s\S]*?filter:\s*none !important/, "Real puzzle last-move squares must not run animated filter pulses");
assert.match(css, /body\.board-theme-animated \.real-puzzle-board-wrap\s*\{[\s\S]*?animation:\s*none !important/, "Animated board-theme shadows must not pulse the real puzzle board");
assert.doesNotMatch(css, /\.real-puzzle-board-wrap\.is-correct\s*\{/, "Real puzzle correct feedback must not animate the board wrapper");
assert.doesNotMatch(css, /\.puzzle-board-wrap\.is-correct\s*\{/, "Correct feedback must not add a board-level shadow layer");
assert.doesNotMatch(app, /puzzleSuccessLanding|puzzle-success-landing/, "Correct moves must not schedule a delayed success overlay");
assert.doesNotMatch(css, /puzzleSuccessLanding|puzzle-success-landing/, "Correct moves must not animate a destination overlay");
assert.match(css, /\.real-puzzle-board-wrap \.real-puzzle-square:disabled\s*\{[\s\S]*?opacity:\s*1 !important/, "Disabled puzzle squares must stay fully visible while replies apply");
assert.match(css, /\.real-puzzle-board-wrap > \.puzzle-board[\s\S]*?transition:\s*none !important/, "Puzzle board must not transition during a correct move");
assert.match(css, /\.real-puzzle-board-wrap \.real-puzzle-square\s*\{[\s\S]*?animation:\s*none !important/, "Puzzle squares must not run capture or check animations");
assert.match(app, /const played = commitRealPuzzlePlayerMove\(move\);[\s\S]*?clearRealPuzzleAnalysisArrows\(\);[\s\S]*?realPuzzleLastMove = played/, "Committed puzzle moves must clear analysis arrows");
assert.match(app, /createAnalysisGestureHandlers\(board, "real-puzzle-user-arrow",[\s\S]*?priority: "support"/, "Puzzle analysis arrows must use the shared skin with a neutral priority");
assert.doesNotMatch(app.slice(app.indexOf("function createAnalysisGestureHandlers("), app.indexOf("function clearAllAnalysisOverlays(")), /color:\s*resolveArrowColor|arrowColor/, "Analysis arrow gestures must not inject semantic colors");
assert.match(app, /const onPointerMove = \(event\) =>[\s\S]*?setPhase\(boardInteractionPhases\.DRAGGING, event\)[\s\S]*?clearAnalysisArrows\("piece-drag-start", board\)/, "Shared drag start must clear player annotations in every board mode");
assert.match(app, /clearAnalysisArrows\("piece-select", board\)[\s\S]*?callbacks\.onSelect/, "Shared piece selection must clear player annotations in every board mode");
assert.match(app, /const destinationName = squareName\(destination\);[\s\S]*?clearAnalysisArrows\("plain-right-click", board\)/, "Plain right-click must clear without clearing on pointerdown");
assert.match(app, /analysisDragged: false[\s\S]*?state\.analysisDragged = true[\s\S]*?state\.gestureCommitted = state\.analysisDragged \|\| arrowAccepted/, "Invalid analysis drags must remain distinct from plain right-click cleanup");
const pointerDownBody = app.slice(app.indexOf("const onPointerDown = (event) =>"), app.indexOf("const onPointerMove = (event) =>"));
assert.doesNotMatch(pointerDownBody, /clearAnalysisArrows\(/, "Manual arrows must not clear before right-drag intent is known");
assert.match(app, /applyRealPuzzleAutoReplies\(1\)[\s\S]*?clearRealPuzzleAnalysisArrows\(\);/, "Puzzle opponent replies must leave analysis arrows cleared");
assert.match(app, /analysisGestures\(square, event\)[\s\S]*?realPuzzleAnalysisEnabled \? "arrow" : false[\s\S]*?event\.button === 2/, "Puzzle arrows must support opt-in touch drawing and desktop right-drag");
assert.match(app, /renderAnalysisOverlay\(\{ board, wrap: board, arrows: \[\], highlights: \[\] \}\)/, "Puzzle renderer must keep the base arrow layer solution-independent");
assert.doesNotMatch(app, /real-puzzle-recommendation|Recommended puzzle move/, "Puzzle mode must not auto-generate solution arrows");
assert.match(css, /\.real-puzzle-board-wrap > \.puzzle-board > \.review-arrow-layer\s*\{[\s\S]*?z-index:\s*2/, "Puzzle arrow layer must stay below pieces");
assert.match(css, /\.real-puzzle-board-wrap \.real-puzzle-square > :is\(\.piece-svg, \.piece-symbol\)\s*\{[\s\S]*?z-index:\s*3/, "Puzzle pieces must remain above arrows");
assert.match(app, /const arrowSkinThemes = Object\.freeze\([\s\S]*?pulse:[\s\S]*?arcane:[\s\S]*?solaris:[\s\S]*?voidflare:[\s\S]*?celestial:/, "Arrow Skin catalog must contain five distinct tiers");
assert.match(app, /const ARROW_SKIN_DEFAULT = "default"[\s\S]*?function getEquippedArrowSkinValue\(\)[\s\S]*?normalizeArrowSkinValue\(activeArrowSkinValue\)/, "Arrow skins must have one normalized runtime source of truth");
assert.match(app, /default:[\s\S]*?label: "Classic Precision"[\s\S]*?cost: 0[\s\S]*?glow: "rgba\(0,0,0,0\)"[\s\S]*?glowAlpha: 0/, "Default Classic Precision must be free and effect-free");
assert.match(app, /const arrowSkinStoreItems = Object\.entries\(arrowSkinThemes\)[\s\S]*?type: "arrowSkin"/, "Default Classic Precision must be represented in the Arrow Skin catalog");
assert.doesNotMatch(app.slice(app.indexOf("const arrowSkinStoreItems"), app.indexOf("const storeItems")), /filter\(\[value\] => value !== "default"\)/, "Default Classic Precision must not be hidden from the catalog");
assert.match(app, /const defaultOwned = [\s\S]*?arrowSkinStoreItems\.filter\(\(item\) => !item\.cost\)/, "New users must own the free Default Arrow Skin");
assert.match(app, /if \(type === "arrowSkin"\) return `arrowskin-\$\{normalizeArrowSkinValue\(prefs\.arrowSkin\)\}`/, "Default and purchased Arrow Skins must share the equipped preference path");
assert.match(app, /const savedArrowSkin = saved[\s\S]*?invalidSavedArrowSkin[\s\S]*?writeJsonStorage\(learnerPrefsStorageKey, prefs\)/, "Invalid persisted Arrow Skins must be corrected and persisted as Default");
assert.match(app, /arcane:[\s\S]*?markerDetails:[\s\S]*?shaftDasharray/, "Arcane must have segmented shaft and faceted marker details");
assert.match(app, /solaris:[\s\S]*?markerDetails:[\s\S]*?headScale:[\s\S]*?innerVisible: true/, "Solaris must have a spearhead facet and restrained shaft accent");
assert.match(app, /voidflare:[\s\S]*?markerDetails:[\s\S]*?shaftDasharray/, "Voidflare must have a forked marker and asymmetric shaft treatment");
assert.match(app, /celestial:[\s\S]*?markerDetails:[\s\S]*?innerVisible: true/, "Celestial must have a crown marker and crafted shaft accent");
assert.match(app, /const skinHeadScale = Number\.isFinite[\s\S]*?priority\.headScale \* skinHeadScale/, "Skin-specific head silhouettes must scale through the shared marker renderer");
assert.match(app, /if \(skin\.shaftDasharray\)[\s\S]*?stroke-dasharray/, "Skin-specific shaft treatments must use shared SVG line styling");
assert.match(app, /if \(!isShadow && Array\.isArray\(skin\.markerDetails\)\)[\s\S]*?detailPath/, "Faceted skin details must be emitted by the shared marker renderer");
assert.match(app, /skinOverride: normalizeArrowSkinValue\(item\?\.value\)/, "Store previews must use the real renderer with an explicit skin preview override");
assert.equal((app.match(/renderAnalysisOverlay\(\{/g) || []).length, 6, "All board modes must use the shared analysis renderer call sites");
assert.match(app, /const arrowSkinStoreItems = Object\.entries\(arrowSkinThemes\)[\s\S]*?type: "arrowSkin"/, "Arrow skins must be first-class Store items");
assert.match(app, /function createArrowSkinPreview\(item\)[\s\S]*?renderAnalysisOverlay\([\s\S]*?skinOverride:/, "Arrow Skin previews must reuse the SVG renderer");
assert.match(app, /function getEquippedArrowSkin\(\)[\s\S]*?function resolveArrowSkinStyle\(/, "Arrow skins must expose the equipped-skin to resolved-style pipeline");
assert.match(app, /const skinStyle = resolveArrowSkinStyle\(state\.skinOverride\)[\s\S]*?const color = getArrowSkinColor\("", skin\)/, "The shared SVG renderer must resolve visible style from the equipped skin");
assert.doesNotMatch(app.slice(app.indexOf("function analysisOverlayControllerFor("), app.indexOf("function renderAnalysisOverlay(")), /arrow\?\.color|arrow\.arrowSkin|normalizeAnalysisColor\(arrow/, "Shared arrow rendering must not resolve semantic arrow colors or per-arrow skins");
assert.match(app, /function getEquippedStoreId\(type\)[\s\S]*?type === "arrowSkin"[\s\S]*?prefs\.arrowSkin/, "Equipped Arrow Skin must derive from learner preferences");
assert.match(app, /async function equipStoreItem\(item\)[\s\S]*?item\?\.type === "arrowSkin"[\s\S]*?isStoreItemOwned\(item\)/, "Unowned Arrow Skins must not be equip-able");
assert.match(app, /const fallback = \{[\s\S]*?arrowSkin: "default"/, "Arrow Skin preference must have a stable free default");
assert.match(app, /function applyLearnerPrefs\(prefs\)[\s\S]*?applyArrowSkin\(prefs\.arrowSkin\)/, "Arrow Skin preference must hydrate with every mode/theme");
assert.match(app, /function applyStartupTheme\(prefs = readLearnerPrefs\(\)\)[\s\S]*?applyArrowSkin\(prefs\.arrowSkin\)/, "Persisted Arrow Skin must hydrate before deferred board routes mount");
const pointerMoveBody = app.slice(app.indexOf("const onPointerMove = (event) =>"), app.indexOf("const onPointerUp = (event) =>"));
assert.doesNotMatch(pointerMoveBody, /renderOpeningExplorerBoard|replaceChildren/, "Pointer movement must not rebuild the Opening Explorer board");
assert.match(app, /if \(wasDragging\) callbacks\.onDrop\?[\s\S]*?finally \{[\s\S]*?cleanupInteraction\(event, \{ suppressClick: true \}\)/, "Every drop path must finish through shared cleanup");
assert.match(app, /openingExplorerReset[\s\S]*?renderOpeningExplorerBoard\(\);[\s\S]*?openingExplorerPrev[\s\S]*?renderOpeningExplorerBoard\(\);[\s\S]*?openingExplorerNext[\s\S]*?renderOpeningExplorerBoard\(\);/, "Opening reset/Previous/Next must flow through the board cancellation boundary");
assert.match(app, /openingExplorerReset[\s\S]*?clearAnalysisArrows\("opening-reset", document\.getElementById\("openingExplorerBoard"\)\)/, "Opening reset must clear manual arrows even when returning to the same position");
assert.match(app, /openingExplorerPrev[\s\S]*?clearAnalysisArrows\("opening-previous", document\.getElementById\("openingExplorerBoard"\)\)/, "Opening Previous must clear manual arrows");
assert.match(app, /openingExplorerNext[\s\S]*?clearAnalysisArrows\("opening-next", document\.getElementById\("openingExplorerBoard"\)\)/, "Opening Next must clear manual arrows");
const makeCoachMoveBody = app.slice(app.indexOf("function makeCoachMove("), app.indexOf("function handleCoachSquare("));
const committedClearIndex = makeCoachMoveBody.indexOf("clearCoachTemporaryAnalysis();");
assert.ok(committedClearIndex > 0, "Play move path does not clear committed annotations");
assert.doesNotMatch(makeCoachMoveBody.slice(0, committedClearIndex), /clearCoachTemporaryAnalysis\(\)/, "Illegal/cancelled Play moves must not clear annotations");
const premoveBody = app.slice(app.indexOf("function tryRunCoachPremove("), app.indexOf("function getTournamentProvider("));
assert.match(premoveBody, /const queued = \{ \.\.\.coachPremove \};\s*coachPremove = null[\s\S]*?if \(!legalMove\) \{[\s\S]*?return false;[\s\S]*?return makeCoachMove\(/, "Premove must clear before one-shot execution and cancel invalid moves");
assert.match(app, /function completeCoachGame\([\s\S]*?coachPremove = null/, "Game end must clear queued premoves");
assert.match(app, /function completeCoachGame\([\s\S]*?clearAnalysisArrows\("game-complete", document\.getElementById\("coachBoard"\)\)/, "Game completion must clear manual arrows");
assert.match(app, /function restartCoachGame\([\s\S]*?clearAnalysisArrows\("game-restart", document\.getElementById\("coachBoard"\)\)/, "Game restart must clear manual arrows");
assert.match(app, /function showReviewPly\([\s\S]*?clearAnalysisArrows\("review-position", document\.getElementById\("coachBoard"\)\)/, "Review Previous/Next navigation must clear manual arrows");
const coachBoardEvents = app.slice(app.indexOf("function bindCoachBoardEvents("), app.indexOf("function ensureCoachBoardSquares("));
assert.match(coachBoardEvents, /onDrop\(from, to\)[\s\S]*?isLivePremoveEnabled\(\)[\s\S]*?return queueCoachPremove\(from, to\)[\s\S]*?makeCoachMove\(from, to\)/, "Opponent-turn drops must queue before normal move validation can reject them");
const coachSquareHandler = app.slice(app.indexOf("function handleCoachSquare("), app.indexOf("function queueCoachReply("));
assert.match(coachSquareHandler, /piece\?\.color === coachPlayerColor[\s\S]*?queueCoachPremove\(square\)[\s\S]*?coachPremove\?\.from && square !== coachPremove\.from[\s\S]*?queueCoachPremove\(coachPremove\.from, square\)/, "A second premove must begin at a new player piece before using the old source as a destination");
const coachRenderBody = app.slice(app.indexOf("function renderCoachBoard("), app.indexOf("function makeCoachMove("));
assert.match(coachRenderBody, /isLivePremoveEnabled\(\) \? "premove-live" : "premove-off"/, "Board render cache must include premove availability");
assert.match(coachRenderBody, /premoveSource[\s\S]*?premove-target[\s\S]*?square\.dataset\.premove = "from"[\s\S]*?square\.dataset\.premove = "to"/, "Queued premoves must expose distinct source and target square state");
assert.match(app, /function queueCoachPremove\(from, to = ""\)[\s\S]*?coachGame\.get\(destination\)\?\.color === coachPlayerColor/, "Premove queue must reject a friendly occupied destination");
assert.match(app, /function renderPremoveStatus\(\)[\s\S]*?data-premove-status-move[\s\S]*?cancel\.disabled = !queued/, "Queued premoves must update both status text and its cancel control");
const boardWrapperIndex = html.indexOf('class="puzzle-board-wrap play-board-wrap cq-glass-container"');
const premoveStatusIndex = html.indexOf('id="premoveStatus"');
assert.ok(premoveStatusIndex > boardWrapperIndex, "Premove status must render after the board wrapper, not inside it");
const boardWrapperMarkup = html.slice(boardWrapperIndex, html.indexOf('<nav class="review-center-timeline"', boardWrapperIndex));
assert.doesNotMatch(boardWrapperMarkup, /id="premoveStatus"/, "Premove status must not be mounted in the board wrapper");
assert.match(html, /id="premoveStatus"[\s\S]*?data-premove-status-move[\s\S]*?id="cancelPremove"/, "Premove status must have move text and a compact cancel control");
const premoveCss = css.slice(css.indexOf(".premove-status {"), css.indexOf(".play-square.premove-source"));
assert.doesNotMatch(premoveCss, /position:\s*absolute|pointer-events:\s*none/, "Premove status cannot be an absolute board overlay or block its own cancel button");
assert.match(css, /\.play-square\.premove-source::before[\s\S]*?data-premove/, "Premove source must carry a visible queued label");
assert.match(app, /function createAnalysisGestureHandlers\([\s\S]*?toggleMatchingArrow[\s\S]*?state\.userArrows/, "Analysis arrows must support same-arrow toggle");
assert.match(app, /userArrows: new Map\(\)/, "Analysis controller must support multiple reusable arrows");
assert.match(css, /\.play-board > \.review-arrow-layer/, "Analysis layer is not scoped to the board");
assert.match(css, /\.review-arrow-layer[\s\S]*background: transparent !important/, "Analysis layer must stay transparent");
assert.match(app, /const arrowGeometry = \(from, to, laneOffset = 0\) =>[\s\S]*?startInset[\s\S]*?endInset/, "Analysis arrows must use board-relative inset geometry");
assert.match(app, /const ANALYSIS_ARROW_GEOMETRY = Object\.freeze/, "Arrow sizing must be centralized in reusable geometry tokens");
assert.match(app, /const lateral = laneOffset \* ANALYSIS_ARROW_GEOMETRY\.laneGap/, "Overlapping arrows must use a deterministic board-relative lane gap");
assert.match(app, /startInset: Object\.freeze\(\{ min: \.08, max: \.12, ratio: \.12 \}\)/, "Arrow origin inset must be centralized");
assert.match(app, /endInset: Object\.freeze\(\{ min: \.11, max: \.16, ratio: \.15 \}\)/, "Arrow destination inset must be centralized");
assert.match(app, /const segmentIntersects = \(a, b\) =>[\s\S]*?const laneOffsets = new Map\(\)/, "Overlapping arrows must identify shared route corridors before offsetting");
assert.match(app, /const shadowGeometry = \{[\s\S]*?geometry\.x1 \+ ANALYSIS_ARROW_GEOMETRY\.depthOffset[\s\S]*?geometry\.y2 \+ ANALYSIS_ARROW_GEOMETRY\.depthOffset/, "Arrow depth must use a subtle offset rail instead of a thick outline");
assert.match(app, /const \[glow, shadow, line, inner\] = \[\.\.\.group\.children\]/, "Analysis arrows must reuse the premium layered SVG group");
assert.match(app, /setAttrIfChanged\(shadow, "marker-end", `url\(#\$\{shadowMarkerId\}\)`\)/, "Arrow depth must include a connected head outline");
assert.match(app, /glow\.removeAttribute\("marker-end"\)/, "Arrow glow layer must not compete with the crisp primary stroke");
assert.match(app, /state\.drawSignature === drawSignature && state\.svg\?\.isConnected/, "Unchanged arrow state must skip redundant SVG redraws");
assert.match(app, /group\.dataset\.arrowSignature === arrowSignature/, "Unchanged arrow geometry/style must skip redundant DOM writes");
assert.match(app, /markerPrefix: `analysis-overlay-\$\{\+\+analysisOverlayControllerSequence\}`/, "Arrow marker IDs must be stable for the controller lifetime");
assert.match(app, /if \(\["best", "engine", "important"\]\.includes\(normalizedKind\)\) return "yellow"/, "Important arrows must use the refined gold treatment");
assert.match(app, /if \(\["pv"\]\s*\.includes\(normalizedKind\)\) return "blue"/, "Primary PV arrows must use cool cyan-blue");
assert.match(app, /if \(\["candidate", "alternative"\]\s*\.includes\(normalizedKind\)\) return "violet"/, "Alternative candidates must use blue-violet");
assert.match(app, /if \(\["plan", "support", "positional", "idea"\]\s*\.includes\(normalizedKind\)\) return "green"/, "Support ideas must use refined emerald");
assert.match(app, /if \(\["threat", "attack", "mistake", "danger"\]\s*\.includes\(normalizedKind\)\) return "red"/, "Danger arrows must use controlled red");
assert.match(app, /if \(\["secondary", "low", "low-priority", "quiet"\]\s*\.includes\(normalizedKind\)\) return "neutral"/, "Low-priority arrows must use neutral gray");
assert.match(app, /const ANALYSIS_ARROW_PRIORITIES = Object\.freeze/, "Arrow priorities must be explicit rather than implicit visual noise");
assert.match(app, /function normalizeAnalysisPriority\(value, kind = ""\)/, "Arrow priorities must normalize semantic kinds");
assert.match(app, /right\.entry\.priority\.value - left\.entry\.priority\.value/, "Highest-priority arrows must win the natural center lane");
assert.match(app, /const lane = rank === 0 \? 0 : \(rank % 2 === 1 \? -Math\.ceil\(rank \/ 2\) : Math\.ceil\(rank \/ 2\)\)/, "Secondary lanes must fan out deterministically around the primary route");
assert.match(app, /default:[\s\S]*?primaryColor: "#8AA7B5"[\s\S]*?pulse:[\s\S]*?primaryColor: "#62D7FF"[\s\S]*?arcane:[\s\S]*?primaryColor: "#B58CFF"/, "Arrow skins must own the visible arrow color");
assert.match(css, /\.review-arrow-line[\s\S]*?stroke-width:\s*var\(--arrow-shaft-width,\s*0\.06\)[\s\S]*?vector-effect:\s*none/, "Arrow shafts must use board-scaled geometry with a readable width");
assert.match(css, /\.review-arrow-shadow[\s\S]*?stroke-width:\s*0\.062[\s\S]*?opacity:\s*calc\(0\.24 \* var\(--arrow-opacity, 1\)\)/, "Arrow depth must remain a subtle navy rail");
assert.match(css, /\.review-arrow-glow[\s\S]*?display:\s*none/, "Arrow glow must not create a competing repaint layer");
assert.match(css, /body:is\(\.perf-lite, \.low-performance, \.reduced-motion\) \.review-arrow-glow[\s\S]*?display: none/, "Reduced-performance modes must simplify glow without hiding arrows");
assert.doesNotMatch(app.slice(app.indexOf("function getReviewOverlayData("), app.indexOf("const ANALYSIS_OVERLAY_NS")), /kind: "(?:played|best|pv|threat)"[^\n]*color:/, "Review arrows must not carry semantic color overrides");
assert.match(app, /marker: Object\.freeze\(\{[\s\S]*?viewBox: "0 0 0\.34 0\.3"/, "Arrowheads must use the compact precision geometry");
assert.match(app, /path: "M0\.015,0\.045 L0\.105,0\.15 L0\.015,0\.255 L0\.325,0\.15 Z"/, "Arrowheads must use the asymmetric Precision Dart profile");
assert.match(app, /setAttrIfChanged\(group, "data-arrow-lane", laneOffset\)/, "Arrow groups must expose their deterministic overlap lane");
assert.match(app, /routeNodeGroup/, "Optional tactical route nodes must have a dedicated SVG layer");
assert.match(app, /showRouteNodes: true/, "Review variation routes must opt into route nodes explicitly");
assert.match(app, /review-arrow-route-node/, "Connected variation waypoints must use the route-node renderer");
assert.match(css, /\.review-arrow-route-node[\s\S]*?pointer-events: none/, "Route nodes must remain pointer-passive");
assert.match(css, /\.review-arrow-line\.is-best\.is-engine[\s\S]*?stroke-dasharray: none/, "Important gold arrows must remain a crisp solid path");
assert.match(css, /\.review-arrow-shadow[\s\S]*pointer-events: none/, "Arrow depth layer must be pointer-passive");
assert.match(css, /\.review-arrow-group\.is-entering[\s\S]*?animation:\s*none/, "Arrows must remain static after insertion");
assert.match(css, /\.review-arrow-line[\s\S]*?transition:\s*none !important/, "Arrow strokes must not transition between frames");
assert.match(css, /\.review-arrow-layer marker[\s\S]*?transition:\s*none !important/, "Arrow markers must not transition between frames");
assert.doesNotMatch(css, /reviewArrowDraw|reviewBestArrowPulse/, "Arrow rendering must not retain looping or dash-offset animation");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.review-arrow-group\.is-entering[\s\S]*?animation: none/, "Reduced-motion preferences must disable arrow arrival motion");
assert.match(css, /@media \(forced-colors: active\)[\s\S]*?\.review-arrow-line[\s\S]*?stroke: Highlight/, "Forced-colors mode must keep arrows readable");
assert.doesNotMatch(perfLiteCss, /body\.perf-lite\s+:where\([^)]*\.review-arrow-layer/, "perf-lite must not hide functional analysis arrows");
assert.match(html, /id="openingExplorerGuidance"/, "Opening Explorer must expose the reusable guidance layer");
assert.match(html, /id="openingExplorerModeGuided"/, "Opening Explorer must expose Guided mode");
assert.match(html, /id="openingExplorerModeRecall"/, "Opening Explorer must expose Recall mode");
assert.match(app, /function getOpeningExplorerGuidance\(\)/, "Opening guidance must derive the next move from the selected line");
assert.match(app, /function setOpeningExplorerMode\(mode\)/, "Opening guidance modes must share one state transition");
assert.match(app, /function advanceOpeningExplorerHint\(\)/, "Recall mode must reveal hints progressively");
assert.match(app, /showGuidanceArrow/, "Opening guidance must reuse the shared arrow renderer");
assert.match(app, /openingExplorerRuntime\.feedback = \{ type: "wrong"/, "Guided/Recall moves must provide wrong-move feedback");
assert.match(openingsCss, /opening-explorer-progress-step/, "Opening guidance must show a progress path");

assert.equal((app.match(/window\.addEventListener\("blur", onWindowBlur\)/g) || []).length, 1, "Duplicate blur listener registration");
assert.equal((app.match(/document\.addEventListener\("visibilitychange", onVisibilityChange\)/g) || []).length, 1, "Duplicate visibility listener registration");
assert.match(app, /activeRegistrations\.delete\(registration\)/, "Detached boards must leave the active registration set");

const cacheName = "nschess-shell-v174-shared-name-style";
const cacheVersion = "review-v174-shared-name-style";
assert.match(html, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "HTML does not use the v174 asset version");
assert.match(app, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Lazy route loaders do not use the v174 asset version");
assert.match(worker, new RegExp(cacheVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker shell assets do not use the v174 asset version");
assert.match(worker, new RegExp(cacheName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Service worker cache name is not v174");
assert.match(worker, /isStoreAudioAsset[\s\S]*?assets\/audio[\s\S]*?cache\.put/, "Store piano recordings must be cacheable after first preview");
assert.match(pianoMigration, /music-quiet-calculation[\s\S]*?music-rising-position[\s\S]*?music-midnight-strategy[\s\S]*?music-beyond-the-board[\s\S]*?music-subtle-triumph[\s\S]*?CC0 1\.0 Universal/);
assert.match(pianoMigration, /set active = false[\s\S]*?music-calm[\s\S]*?sfx-classic/);
[
  ["index.html", html],
  ["assets/app.js", app],
  ["service-worker.js", worker],
  ["docs/DEPLOYMENT-CHECKLIST.md", deployment]
].forEach(([file, source]) => {
  assert.doesNotMatch(source, /review-v129-interaction-polish|nschess-shell-v129-interaction-polish/, `${file} retains a stale deployment cache identifier`);
});

console.log("board-interaction-regression: lifecycle and cache contracts passed");
