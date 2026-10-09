export async function bootDailyPuzzle() {
  const root = document.getElementById("dailyPuzzlePanel");
  if (!root) throw new Error("The Daily Puzzle interface is unavailable.");
  const [response, chessModule, dailyCore] = await Promise.all([
    fetch(new URL("../data/daily-puzzles-original.v1.json", import.meta.url), { cache: "force-cache" }),
    import("./vendor/chess.js-1.0.0.mjs"),
    import("./daily-puzzle-core.mjs")
  ]);
  const { Chess, validateFen } = chessModule;
  const { DAILY_STORAGE_KEY, dailyStreak, nextUtcMidnight, parseDailyState, recordDailyAttempt, selectDailyPuzzle, utcDayKey } = dailyCore;
  if (!response.ok) throw new Error("Reconnect once to cache the original puzzle pack for offline play.");
  const catalog = await response.json();
  if (catalog.version !== 1 || !Array.isArray(catalog.puzzles) || catalog.puzzles.length < 4) throw new Error("The original puzzle pack has an unsupported format.");
  const puzzles = catalog.puzzles.map((puzzle) => validatePuzzle(puzzle));
  if (new Set(puzzles.map((puzzle) => puzzle.id)).size !== puzzles.length) throw new Error("Puzzle identifiers must be unique.");

  const elements = {
    panel: root,
    board: document.getElementById("dailyPuzzleBoard"),
    play: document.getElementById("dailyPuzzlePlay"),
    start: document.getElementById("dailyPuzzleStartButton"),
    date: document.getElementById("dailyPuzzleDate"),
    attempts: document.getElementById("dailyPuzzleAttempts"),
    streak: document.getElementById("dailyPuzzleStreak"),
    theme: document.getElementById("dailyPuzzleTheme"),
    side: document.getElementById("dailyPuzzleSide"),
    title: document.getElementById("dailyPuzzleTitle"),
    prompt: document.getElementById("dailyPuzzlePrompt"),
    feedback: document.getElementById("dailyPuzzleFeedback"),
    hint: document.getElementById("dailyPuzzleHint"),
    next: document.getElementById("dailyPuzzleNext"),
    storage: document.getElementById("dailyPuzzleStorageStatus"),
    launch: document.querySelector("[data-daily-puzzle-launch]")
  };
  if (Object.values(elements).some((element) => !element)) throw new Error("The Daily Puzzle interface is incomplete.");

  let state = readState();
  let dayKey = "";
  let puzzle = null;
  let game = null;
  let selectedSquare = "";
  let lastMove = null;
  let focusedSquare = "";
  let hintStep = 0;
  let assisted = false;
  let inSession = false;
  let solvedThisSession = false;
  let dailyTimer = 0;

  function readState() {
    try {
      const parsed = parseDailyState(localStorage.getItem(DAILY_STORAGE_KEY));
      if (parsed.recovered) elementsStatusWarning();
      return parsed.state;
    } catch {
      elementsStatusWarning();
      return parseDailyState(null).state;
    }
  }

  function elementsStatusWarning() {
    const status = document.getElementById("dailyPuzzleStorageStatus");
    if (status) status.textContent = "Saved data was unreadable, so this device starts a fresh Daily Puzzle record. No account data is affected.";
  }

  function saveState() {
    try {
      localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(state));
      elements.storage.textContent = "Saved on this device · not synced";
      return true;
    } catch {
      elements.storage.textContent = "Browser storage is unavailable; progress lasts only in this tab.";
      return false;
    }
  }

  function dayRecord() {
    return state.days[dayKey] || { attempts: 0, wrong: 0, completed: false, assisted: false };
  }

  function renderSummary() {
    const record = dayRecord();
    elements.date.textContent = dayKey;
    elements.attempts.textContent = String(record.attempts);
    elements.streak.textContent = `${dailyStreak(state, dayKey)} day${dailyStreak(state, dayKey) === 1 ? "" : "s"}`;
    elements.start.textContent = record.completed ? "Practice today's puzzle again" : "Play today's puzzle";
    elements.start.setAttribute("aria-label", record.completed ? "Practice today's completed puzzle again; local progress will not change" : "Play today's Daily Puzzle");
    if (!elements.storage.textContent || elements.storage.textContent === "Puzzle content is checked for legal moves before play.") {
      elements.storage.textContent = record.completed ? "Completed on this device · no XP or account reward" : "Device-local progress · no XP or account reward";
    }
    updateNextPuzzle();
  }

  function updateNextPuzzle() {
    const remaining = Math.max(0, nextUtcMidnight() - Date.now());
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    elements.next.textContent = `A new shared puzzle is selected at 00:00 UTC (in ${hours}h ${minutes}m).`;
  }

  function currentDayPuzzle() {
    return selectDailyPuzzle(dayKey, puzzles);
  }

  function ensureToday() {
    const current = utcDayKey();
    if (current === dayKey) return;
    const wasPlaying = inSession;
    dayKey = current;
    puzzle = currentDayPuzzle();
    game = puzzle ? new Chess(puzzle.fen) : null;
    selectedSquare = "";
    lastMove = null;
    hintStep = 0;
    assisted = false;
    solvedThisSession = false;
    inSession = wasPlaying;
    renderSummary();
    if (inSession) renderBoard();
    if (wasPlaying) elements.feedback.textContent = "The UTC day changed. Today's new original position is ready.";
  }

  function openDailyMode() {
    elements.panel.hidden = false;
    const ordinaryShell = document.querySelector("#realPuzzles .real-puzzle-shell");
    if (ordinaryShell) ordinaryShell.hidden = true;
    elements.launch.setAttribute("aria-pressed", "true");
    document.querySelectorAll(".real-puzzle-modes [data-real-mode]").forEach((button) => button.setAttribute("aria-pressed", "false"));
    ensureToday();
    elements.panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeDailyMode() {
    elements.launch.setAttribute("aria-pressed", "false");
    elements.panel.hidden = true;
    const ordinaryShell = document.querySelector("#realPuzzles .real-puzzle-shell");
    if (ordinaryShell) ordinaryShell.hidden = false;
  }

  function startOrReplay() {
    ensureToday();
    inSession = true;
    solvedThisSession = false;
    hintStep = 0;
    assisted = false;
    selectedSquare = "";
    lastMove = null;
    game = new Chess(puzzle.fen);
    elements.play.hidden = false;
    elements.start.hidden = true;
    elements.hint.hidden = true;
    elements.feedback.textContent = dayRecord().completed
      ? "This is already complete today on this device. Replay for practice; the saved record will not change."
      : "Select a piece, then a highlighted destination. Arrow keys, Enter, and Space also work.";
    renderBoard();
    const first = elements.board.querySelector("button[data-square]");
    first?.focus({ preventScroll: true });
    focusedSquare = first?.dataset.square || "";
  }

  function getBoardSquares() {
    const files = puzzle.side === "b" ? "hgfedcba" : "abcdefgh";
    const ranks = puzzle.side === "b" ? "12345678" : "87654321";
    return [...ranks].flatMap((rank) => [...files].map((file) => `${file}${rank}`));
  }

  function renderBoard() {
    if (!game) return;
    elements.side.textContent = game.isCheckmate() ? "Checkmate" : `${game.turn() === "w" ? "White" : "Black"} to move`;
    const legalMoves = selectedSquare ? game.moves({ square: selectedSquare, verbose: true }) : [];
    const byTarget = new Map();
    legalMoves.forEach((move) => byTarget.set(move.to, move));
    const squares = getBoardSquares();
    if (!squares.includes(focusedSquare)) focusedSquare = squares[0];
    const checkedSquare = game.isCheck()
      ? squares.find((square) => game.get(square)?.type === "k" && game.get(square)?.color === game.turn())
      : "";
    const nodes = squares.map((square, index) => {
      const piece = game.get(square);
      const legal = byTarget.get(square);
      const [file, rank] = [square.charCodeAt(0) - 97, Number(square[1])];
      const light = (file + rank) % 2 === 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `real-puzzle-square puzzle-square play-square ${light ? "light" : "dark"}`;
      if (piece) button.classList.add(piece.color === "w" ? "white-piece" : "black-piece");
      if (square === selectedSquare) button.classList.add("selected");
      if (legal) button.classList.add(legal.captured || String(legal.flags).includes("e") ? "capture" : "legal");
      if (lastMove && (square === lastMove.from || square === lastMove.to)) button.classList.add("last-move");
      if (square === checkedSquare) button.classList.add("in-check");
      button.dataset.square = square;
      button.tabIndex = square === focusedSquare || (!focusedSquare && index === 0) ? 0 : -1;
      button.setAttribute("aria-label", `${square}, ${piece ? `${piece.color === "w" ? "white" : "black"} ${pieceName(piece.type)}` : "empty"}${square === selectedSquare ? ", selected" : ""}${legal ? ", legal destination" : ""}${square === checkedSquare ? ", king in check" : ""}`);
      button.disabled = solvedThisSession;
      if (piece) {
        const image = document.createElement("img");
        image.className = `piece-svg ${piece.color === "w" ? "white-piece-svg" : "black-piece-svg"}`;
        image.src = new URL(`./pieces/merida/${piece.color}${piece.type.toUpperCase()}.svg`, import.meta.url).href;
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        image.draggable = false;
        image.decoding = "async";
        button.append(image);
        button.draggable = piece.color === game.turn() && !solvedThisSession;
      }
      return button;
    });
    elements.board.replaceChildren(...nodes);
  }

  function pieceName(type) {
    return ({ p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" })[type] || "piece";
  }

  function handleSquare(square) {
    ensureToday();
    if (!inSession || solvedThisSession || !game) return;
    const target = game.get(square);
    if (selectedSquare && square === selectedSquare) {
      selectedSquare = "";
      renderBoard();
      return;
    }
    if (selectedSquare) {
      const candidates = game.moves({ square: selectedSquare, verbose: true }).filter((move) => move.to === square);
      if (candidates.length) {
        const promotion = candidates.find((move) => move.promotion === "q")?.promotion || candidates[0].promotion;
        attemptMove(selectedSquare, square, promotion);
        return;
      }
    }
    if (target && target.color === game.turn()) {
      selectedSquare = square;
      focusedSquare = square;
      elements.feedback.textContent = `${pieceName(target.type)} selected. Choose a highlighted legal destination.`;
    } else if (selectedSquare) {
      elements.feedback.textContent = "That is not a legal destination. Choose one of the highlighted squares.";
    } else {
      elements.feedback.textContent = "Choose a piece belonging to the side to move.";
    }
    renderBoard();
  }

  function attemptMove(from, to, promotion) {
    const mover = game.turn();
    let move;
    try {
      move = game.move({ from, to, ...(promotion ? { promotion } : {}) });
    } catch {
      move = null;
    }
    if (!move) {
      elements.feedback.textContent = "That move is not legal. The position has not changed.";
      selectedSquare = "";
      renderBoard();
      return;
    }
    lastMove = { from: move.from, to: move.to };
    selectedSquare = "";
    const correct = isObjectiveComplete(puzzle, game, move, mover);
    if (dayRecord().completed) {
      elements.feedback.textContent = correct
        ? `Good move, ${move.san}. This local puzzle was already completed today; replay does not change its saved record.`
        : `Not the puzzle idea. ${move.san} is legal; restart the position and try again.`;
      if (!correct) restartPosition(false);
      else renderBoard();
      return;
    }
    state = recordDailyAttempt(state, dayKey, correct, assisted);
    saveState();
    renderSummary();
    if (correct) {
      solvedThisSession = true;
      const saved = state.days[dayKey];
      elements.feedback.textContent = `Solved: ${move.san}. ${puzzle.explanation} ${saved?.assisted ? "Assisted solve · " : ""}Saved on this device only; no XP, rating, coins, or account reward.`;
      elements.hint.hidden = true;
      elements.start.hidden = false;
      elements.start.textContent = "Practice today's puzzle again";
      elements.start.setAttribute("aria-label", "Practice today's completed puzzle again; local progress will not change");
    } else {
      elements.feedback.textContent = `Not the tactical idea yet. ${move.san} is legal; the position is reset so you can try again.`;
      restartPosition(false);
    }
    renderBoard();
  }

  function isObjectiveComplete(targetPuzzle, after, move, mover) {
    if (targetPuzzle.objective === "mate-in-one") return after.isCheckmate();
    if (targetPuzzle.objective !== "royal-fork" || move.piece !== "n" || !after.isCheck()) return false;
    const enemy = after.turn();
    const enemyQueen = after.board().flat().find((piece) => piece?.type === "q" && piece.color === enemy);
    if (!enemyQueen || !after.attackers(enemyQueen.square, mover).includes(move.to)) return false;
    const replies = after.moves({ verbose: true });
    if (!replies.length) return false;
    return replies.every((reply) => {
      const continuation = new Chess(after.fen());
      continuation.move(reply.san);
      const queen = continuation.get(enemyQueen.square);
      return queen?.type === "q" && queen.color === enemy && continuation.attackers(enemyQueen.square, mover).includes(move.to);
    });
  }

  function restartPosition(announce = true) {
    ensureToday();
    if (!puzzle) return;
    game = new Chess(puzzle.fen);
    selectedSquare = "";
    lastMove = null;
    hintStep = 0;
    assisted = false;
    solvedThisSession = false;
    inSession = true;
    elements.play.hidden = false;
    elements.start.hidden = true;
    elements.hint.hidden = true;
    if (announce) elements.feedback.textContent = dayRecord().completed
      ? "Position restarted for practice. Today's completed local record will not change."
      : "Position restarted. Select a piece, then a highlighted destination.";
    renderBoard();
  }

  function showHint() {
    ensureToday();
    if (!inSession || !puzzle || solvedThisSession) return;
    assisted = true;
    const text = puzzle.hints[Math.min(hintStep, puzzle.hints.length - 1)];
    hintStep += 1;
    elements.hint.textContent = text;
    elements.hint.hidden = false;
    elements.feedback.textContent = `Hint ${Math.min(hintStep, puzzle.hints.length)} of ${puzzle.hints.length}. Take your time; hints do not count as attempts.`;
  }

  function revealSolution() {
    ensureToday();
    if (!inSession || !puzzle || solvedThisSession) return;
    assisted = true;
    const example = new Chess(puzzle.fen);
    const move = example.move({ from: puzzle.solutionUci.slice(0, 2), to: puzzle.solutionUci.slice(2, 4), ...(puzzle.solutionUci.length > 4 ? { promotion: puzzle.solutionUci[4] } : {}) });
    if (!move) return;
    elements.hint.textContent = `One correct move: ${move.san}. Revealing does not complete the puzzle; play a correct move to record a local solve.`;
    elements.hint.hidden = false;
    elements.feedback.textContent = puzzle.explanation;
  }

  function validatePuzzle(item) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.fen !== "string" || !["mate-in-one", "royal-fork"].includes(item.objective)) throw new Error("A puzzle entry is missing a required field.");
    const fenResult = validateFen(item.fen);
    if (!fenResult.ok) throw new Error(`Invalid FEN for ${item.id}: ${fenResult.error}`);
    const position = new Chess(item.fen);
    if (position.isCheckmate() || position.isStalemate()) throw new Error(`Puzzle ${item.id} is already over.`);
    const uci = String(item.solutionUci || "").toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`Puzzle ${item.id} has a malformed solution move.`);
    const move = position.moves({ verbose: true }).find((candidate) => candidate.from === uci.slice(0, 2) && candidate.to === uci.slice(2, 4) && (!candidate.promotion || candidate.promotion === uci[4]));
    if (!move) throw new Error(`Puzzle ${item.id} solution is not legal.`);
    const after = new Chess(item.fen);
    const applied = after.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
    if (!applied || !isObjectiveComplete(item, after, applied, position.turn())) throw new Error(`Puzzle ${item.id} solution does not satisfy its objective.`);
    if (item.objective === "mate-in-one") {
      const matingMoves = position.moves({ verbose: true }).filter((candidate) => {
        const trial = new Chess(item.fen);
        trial.move({ from: candidate.from, to: candidate.to, ...(candidate.promotion ? { promotion: candidate.promotion } : {}) });
        return trial.isCheckmate();
      });
      if (!matingMoves.length) throw new Error(`Puzzle ${item.id} has no legal mate in one.`);
    }
    return Object.freeze({ ...item, solutionUci: uci });
  }

  function updateBoardFocus(event) {
    const current = event.target.closest("button[data-square]");
    if (!current) return;
    const squares = getBoardSquares();
    const index = squares.indexOf(current.dataset.square);
    const row = Math.floor(index / 8);
    const col = index % 8;
    const offsets = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!offsets) return;
    event.preventDefault();
    const nextRow = Math.max(0, Math.min(7, row + offsets[0]));
    const nextCol = Math.max(0, Math.min(7, col + offsets[1]));
    focusedSquare = squares[nextRow * 8 + nextCol];
    renderBoard();
    elements.board.querySelector(`[data-square="${focusedSquare}"]`)?.focus({ preventScroll: true });
  }

  elements.start.addEventListener("click", startOrReplay);
  elements.board.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-square]");
    if (button) handleSquare(button.dataset.square);
  });
  elements.board.addEventListener("keydown", updateBoardFocus);
  elements.board.addEventListener("dragstart", (event) => {
    const button = event.target.closest("button[data-square]");
    if (!button || !game.get(button.dataset.square) || game.get(button.dataset.square).color !== game.turn()) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", button.dataset.square);
  });
  elements.board.addEventListener("dragover", (event) => {
    if (event.target.closest("button[data-square]")) event.preventDefault();
  });
  elements.board.addEventListener("drop", (event) => {
    const target = event.target.closest("button[data-square]");
    const from = event.dataTransfer?.getData("text/plain");
    if (!target || !from) return;
    event.preventDefault();
    const to = target.dataset.square;
    const candidate = game.moves({ square: from, verbose: true }).find((move) => move.to === to);
    if (candidate) attemptMove(from, to, candidate.promotion === "q" ? "q" : candidate.promotion);
    else elements.feedback.textContent = "That is not a legal move. The position has not changed.";
  });
  elements.board.addEventListener("focusin", (event) => {
    const button = event.target.closest("button[data-square]");
    if (button) focusedSquare = button.dataset.square;
  });
  document.getElementById("dailyPuzzleHintButton").addEventListener("click", showHint);
  document.getElementById("dailyPuzzleRevealButton").addEventListener("click", revealSolution);
  document.getElementById("dailyPuzzleRestartButton").addEventListener("click", () => restartPosition(true));
  document.querySelector(".real-puzzle-modes")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-real-mode]")) closeDailyMode();
  }, true);
  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#puzzles")) closeDailyMode();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === DAILY_STORAGE_KEY) {
      state = readState();
      renderSummary();
    }
  });
  elements.start.disabled = false;
  dayKey = utcDayKey();
  puzzle = currentDayPuzzle();
  game = new Chess(puzzle.fen);
  renderSummary();
  elements.storage.textContent = "Device-local progress · offline ready after this puzzle pack is cached";
  updateNextPuzzle();
  dailyTimer = window.setInterval(() => {
    ensureToday();
    updateNextPuzzle();
  }, 60000);
  window.addEventListener("pagehide", () => window.clearInterval(dailyTimer), { once: true });
  return Object.freeze({ openDailyMode });
}
