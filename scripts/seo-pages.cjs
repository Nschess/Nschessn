"use strict";

// One reviewed inventory drives public HTML, metadata, related links and sitemap.
// No account data, clock-dependent puzzle snapshots or claimed ratings belong here.
const origin = "https://nschessn.vercel.app";
const pages = [
  {
    path: "/learn/", hash: "tutorial", label: "Chess lessons",
    title: "Free Chess Lessons for Beginners | Nschess",
    description: "Learn chess with free guided board exercises on piece movement, king safety, tactics and endgames. Start with the basics and practice at your own pace.",
    heading: "Free chess lessons, one move at a time",
    intro: "Start with how the board works, then build the habits that make your next game easier. Nschess offers guided board exercises with instructions and feedback, without requiring an account to begin.",
    action: "Start the guided lessons",
    sections: [
      ["Start with the board and pieces", "Place the board so the square at your right-hand corner is light. Each side begins with eight pawns, two rooks, two knights, two bishops, a queen and a king. The queen starts on a square of her own color. Learn how each piece moves before trying to memorize openings."],
      ["Build a beginner practice routine", "Work through a board exercise, read the feedback, and repeat the move until you can explain it. Then try a tactic or a short computer game. The guided library covers board setup, piece movement and practical chess ideas; the lesson checklist is stored on this device, rather than synced to an account."],
      ["Learn to keep your pieces safe", "Before each move, ask which pieces are attacked and what your opponent threatens. Look for checks, captures and threats on both sides. A knight fork attacks two targets at once; a pin makes moving a defender costly. Practicing these patterns is more useful than rushing through many lessons."],
      ["Put the lesson to work", "Once you know the legal moves, practice developing your knights and bishops, controlling central squares, and making your king safe. Play a manageable bot, then review one decision from the game. Return to the lesson when you find a rule or pattern you cannot explain."]
    ], related: ["/chess-rules/", "/puzzles/", "/play-computer/", "/chess-training/"]
  },
  {
    path: "/puzzles/", hash: "puzzles", label: "Chess puzzles",
    title: "Free Chess Puzzles and Tactics Practice | Nschess",
    description: "Practice chess tactics with free interactive puzzles. Train checks, captures, forks, pins and checkmates, then learn from move feedback and solutions.",
    heading: "Practice chess tactics with free puzzles",
    intro: "A chess puzzle asks you to find a useful move in a specific position. Nschess combines interactive board practice with feedback so you can work on recognizing tactical ideas before meeting them in a game.",
    action: "Open puzzle practice",
    sections: [
      ["A method for solving a position", "First identify whose turn it is and whether either king is in danger. Examine checks, then captures, then threats. For each candidate move, imagine the opponent's strongest reply. A move that looks attractive is only useful if it survives that reply."],
      ["Recognize the tactical patterns", "A fork attacks more than one target. A pin restricts a piece because moving it exposes something more valuable behind it. A skewer attacks a valuable piece and wins a target when it moves. In a checkmate puzzle, count the king's escape squares and the defenders of the checking piece."],
      ["Use feedback deliberately", "Choose your move on the board, read the result and revisit the position if you missed the idea. Hints and solutions help you understand a pattern, but try to calculate first. Short, focused sessions give you time to explain why the move works."],
      ["Take the pattern into a game", "After puzzle practice, play a computer opponent and watch for the same tactical motif. Review a missed opportunity rather than measuring a session only by speed. You can also try the daily local puzzle for a single position to study each day."]
    ], related: ["/daily-chess-puzzle/", "/learn/", "/play-computer/", "/game-review/"]
  },
  {
    path: "/daily-chess-puzzle/", hash: "puzzles", label: "Daily puzzle",
    title: "Daily Chess Puzzle: Free Local Practice | Nschess",
    description: "Try Nschess's daily chess puzzle from its original rotating catalog. Get hints and move feedback, with attempts and streaks stored locally on your device.",
    heading: "A daily chess puzzle for focused practice",
    intro: "Study one position, calculate a forcing line, and check your idea on the board. Nschess's Daily · local mode selects a puzzle from its original catalog by UTC date. It is available without an account.",
    action: "Open puzzles and choose Daily · local",
    sections: [
      ["How to open today's puzzle", "Open the puzzle workspace, then select Daily · local. The daily board shows the side to move and the puzzle prompt. Use a hint when you are stuck, or study the solution when it becomes available. The interactive board requires JavaScript; this guide and its links can be read without it."],
      ["A rotating catalog, not an unlimited archive", "The daily mode uses a shipped catalog of original puzzles and rotates through it. The selected position changes at midnight UTC and can repeat when the catalog cycles. It does not claim to publish a newly authored puzzle every day."],
      ["Attempts and streaks stay on this device", "Daily attempts and streaks are local practice records. They do not award account coins, XP or a server-backed leaderboard score. Clearing browser storage removes local records, and they do not automatically follow you to another device."],
      ["Get more from one position", "Say what your move threatens before playing it. Look for the opponent's best defense, then compare it with the puzzle's continuation. If you solve the position, explain the pattern in your own words. If the daily catalog cannot load, ordinary puzzle practice offers another way to train."]
    ], related: ["/puzzles/", "/chess-training/", "/learn/"]
  },
  {
    path: "/play-computer/", hash: "bots", label: "Play a computer",
    title: "Play Chess Against a Computer for Free | Nschess",
    description: "Choose a computer opponent for free chess practice in Nschess. Build confidence with beginner bots and try harder engine-backed levels when you are ready.",
    heading: "Play chess against a computer at your own pace",
    intro: "Use a practice game to test what you have learned. Nschess has computer opponents with different practice difficulty levels, so beginners can start gently and increase the challenge as their decisions improve.",
    action: "Choose a computer opponent",
    sections: [
      ["Choose a manageable opponent", "Open AI Bots, choose an opponent and start a game. Practice levels describe relative difficulty, rather than a verified human Elo rating. Beginner practice opponents use local move logic; harder levels require the bundled Stockfish engine to be available."],
      ["Give your game one purpose", "Try developing your knights and bishops before moving the same piece repeatedly. Check for undefended pieces, avoid exposing your king and look for your opponent's threat before every move. One clear goal makes a practice game easier to learn from."],
      ["Practice without signing in", "You can start local bot practice as a guest. Online human games and other account features have separate sign-in requirements. Some harder opponents need an engine download and initialization, so begin with a local practice level if the engine cannot load."],
      ["Review a decision after the game", "Finish the game, open its review from the result and replay a moment that confused you. Ask whether you missed a check, a capture or a threat. Engine suggestions are coaching aids; they do not turn a practice result into a calibrated rating or a guaranteed measure of strength."]
    ], related: ["/learn/", "/puzzles/", "/game-review/", "/chess-openings/"]
  },
  {
    path: "/game-review/", hash: "game-review", label: "Game review",
    title: "Chess Game Review and Move Analysis | Nschess",
    description: "Review a completed Nschess game, replay moves and use engine coaching to understand your decisions. Find one practical idea to improve your next game.",
    heading: "Understand your decisions with chess game review",
    intro: "A finished game can teach you more than its result. Nschess's review workspace lets you revisit completed games, replay their moves and use engine coaching to examine important decisions.",
    action: "Open the review workspace",
    sections: [
      ["Bring a completed game to Review", "Finish a Nschess game and open Review from its result. Saved games on this device can also be reopened from Profile. Opening an empty review workspace does not create a game to analyze; play a practice game first if you have no saved game."],
      ["Replay before asking the engine", "Find a move where you felt uncertain and describe your plan. Check what changed after your move: did a piece become undefended, did your king lose protection, or did a tactical threat appear? Compare the position with the opponent's actual reply."],
      ["Use analysis as a learning aid", "The review board, move list, timeline and coaching views help you connect a decision with its consequences. Engine analysis needs the engine to load and run on your device. A suggested move is an analysis result, not a new game result, reward or promise of improvement."],
      ["Turn one mistake into practice", "Choose one pattern to work on next. If you missed a fork, solve tactics. If you struggled to develop your pieces, revisit opening principles. Keep the next training session specific enough that you can recognize the same situation in a future game."]
    ], related: ["/play-computer/", "/puzzles/", "/chess-notation/", "/chess-training/"]
  },
  {
    path: "/chess-rules/", hash: "rules", label: "Chess rules",
    title: "Chess Rules for Beginners: Pieces and Checkmate | Nschess",
    description: "Learn the basic rules of chess: piece movement, check, checkmate, stalemate, castling and promotion. Put the rules into practice with Nschess lessons.",
    heading: "The basic chess rules for beginners",
    intro: "Two players take turns moving one piece at a time, with White moving first. Your goal is to checkmate the opposing king: attack it so that no legal move can remove the attack.",
    action: "Explore the rules in Nschess",
    sections: [
      ["How the pieces move", "Rooks move along ranks and files; bishops move diagonally. The queen combines those movements. A knight moves two squares in one direction and one at a right angle, and can jump over pieces. The king moves one square in any direction, but cannot move into attack. Sliding pieces cannot jump over pieces."],
      ["Pawns, captures and promotion", "Pawns move one square forward into an empty square and may move two from their starting square if both squares are clear. They capture one square diagonally forward. A pawn reaching the farthest rank promotes to a queen, rook, bishop or knight. En passant is a special capture available immediately after an adjacent opposing pawn advances two squares and passes a square your pawn attacks."],
      ["Check, checkmate and stalemate", "When your king is attacked, you must remove the check by moving the king, capturing the attacker or blocking the attack when possible. Checkmate means there is no legal answer to check. Stalemate means the player to move is not in check but has no legal move; it is a draw. Kings are never captured."],
      ["Castling and drawn games", "Castling moves the king two squares toward a rook and brings that rook to the square the king crossed. The king and that rook must not have moved, the squares between them must be empty, and the king cannot castle while in check or through an attacked square. Games can also end in draws through repetition, move-count rules, agreement or a position in which no legal sequence can lead to checkmate."]
    ], related: ["/learn/", "/chess-notation/", "/play-computer/"]
  },
  {
    path: "/chess-openings/", hash: "openings", label: "Chess openings",
    title: "Chess Opening Principles and Beginner Practice | Nschess",
    description: "Learn chess opening principles and explore the Italian Game, Queen's Gambit and other openings in Nschess. Practice development, central control and king safety.",
    heading: "Start your chess opening with a plan",
    intro: "An opening is the first phase of a game, when you bring your pieces into play. Nschess's opening workspace combines example lines with board exploration so you can study ideas as well as moves.",
    action: "Open the opening explorer",
    sections: [
      ["Three principles before memorization", "Fight for the central squares, develop knights and bishops, and prepare king safety. Avoid moving your queen into attacks or spending many turns on one piece without a clear reason. A useful opening move helps your pieces cooperate."],
      ["The Italian Game", "After 1. e4 e5 2. Nf3 Nc6 3. Bc4, White has developed two pieces and placed a bishop toward the f7 square. The lesson is to connect development with a purpose while preparing castling. Black also needs active pieces and a safe king; the line is a starting position, not a forced win."],
      ["The Queen's Gambit", "After 1. d4 d5 2. c4, White challenges Black's central pawn. If Black captures on c4, White can focus on central control and development instead of immediately chasing the pawn. Study how pawn moves affect the squares available to both sides."],
      ["Explore, then test your understanding", "The opening library also includes examples such as the Sicilian Defense, Ruy Lopez, French Defense and Caro-Kann Defense. Play through a line and explain the purpose of each move. Then try a computer game and review the first moment when your pieces stopped working together."]
    ], related: ["/learn/", "/play-computer/", "/game-review/", "/chess-notation/"]
  },
  {
    path: "/chess-notation/", hash: "notation", label: "Chess notation",
    title: "How to Read Chess Notation: A Beginner Guide | Nschess",
    description: "Read algebraic chess notation with examples of piece moves, captures, check and castling. Use Nschess's notation workspace to connect move text with the board.",
    heading: "Read chess notation and follow a game",
    intro: "Chess notation records moves so you can replay a game, study an opening or describe a tactic. Algebraic notation names a piece and its destination, adding symbols when a capture, check or promotion occurs.",
    action: "Practice notation in Nschess",
    sections: [
      ["Name the squares and pieces", "Files are labeled a through h and ranks 1 through 8. The square e4 is on the e-file and fourth rank. In English algebraic notation, K means king, Q queen, R rook, B bishop and N knight. Pawn moves have no piece letter."],
      ["Read a short opening", "In 1. e4 e5 2. Nf3 Nc6, White first moves a pawn to e4 and Black replies with a pawn to e5. White's second move brings a knight to f3, followed by Black's knight to c6. The move number groups White's move with Black's reply."],
      ["Captures, checks and special moves", "Bxe5 means a bishop captures on e5. A plus sign means check and a hash sign means checkmate. O-O is kingside castling and O-O-O is queenside castling. A promotion such as e8=Q names the new piece. If two pieces of the same type can reach a square, an extra file or rank identifies which one moves."],
      ["Connect notation to review", "Follow the move list while replaying a completed game. Before advancing, locate the origin and destination squares and identify the threat. PGN is a text format for game moves and headers; Nschess includes PGN tools in the play workspace, while saved-game Review is opened from a completed game's result or Profile."]
    ], related: ["/chess-rules/", "/chess-openings/", "/game-review/"]
  },
  {
    path: "/chess-training/", hash: "plan", label: "Chess training",
    title: "Beginner Chess Training: Lessons, Puzzles and Practice | Nschess",
    description: "Build a practical chess training routine with Nschess lessons, tactics puzzles, computer games and game review. Focus on one useful idea at a time.",
    heading: "Build a chess training routine you can repeat",
    intro: "You do not need to do everything in one session. Combine a small amount of study with a position to solve, a practice game and one decision to review. Nschess's study-plan workspace helps you choose a focus.",
    action: "Open the study-plan workspace",
    sections: [
      ["Begin with one idea", "If you are new to chess, start with piece movement and legal moves. Once those are comfortable, choose a topic such as protecting loose pieces, finding forks or developing in the opening. Read a lesson and explain the idea before moving on."],
      ["Use a short tactics session", "Solve a few puzzles slowly enough to check the opponent's reply. The daily local puzzle can give you one position to think about, while ordinary puzzle practice lets you repeat tactical patterns. Accuracy and understanding are more helpful goals than a long streak of guesses."],
      ["Play a game with a focus", "Choose a manageable computer opponent and apply your chosen idea. For example, try to develop both knights and bishops while checking for threats. A loss can still be useful practice if you recognize the decision that changed the position."],
      ["Review and choose the next step", "After finishing, revisit one uncertain move. If it reveals a rule you did not know, return to lessons. If it reveals a missed tactic, return to puzzles. The study plan is a way to organize practice, not a guarantee of rating gains or a substitute for thinking through your moves."]
    ], related: ["/learn/", "/puzzles/", "/daily-chess-puzzle/", "/play-computer/", "/game-review/"]
  }
];

const legalPages = [
  { path: "/privacy.html", title: "Privacy Policy | Nschess", description: "How Nschess handles device storage, online account information, privacy choices and data deletion requests." },
  { path: "/terms.html", title: "Terms of Use | Nschess", description: "Read the terms for using Nschess chess practice, account features and community services." },
  { path: "/account-deletion.html", title: "Account Deletion | Nschess", description: "Learn how to request deletion of a Nschess online account and manage device-local chess data." }
];
const home = {
  path: "/", title: "Nschess | Free Chess Lessons, Puzzles and Computer Practice",
  description: "Learn and practice chess for free with guided lessons, tactics puzzles, computer opponents and completed-game review. Start as a guest in Nschess."
};
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
function metadata(page, index = true) {
  const url = origin + page.path;
  return `<title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <meta name="robots" content="${index ? "index, follow" : "noindex, follow"}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Nschess" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="${escape(page.title)}" />
  <meta property="og:description" content="${escape(page.description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${origin}/assets/icons/icon-512.png" />
  <meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />
  <meta property="og:image:alt" content="Nschess app icon" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escape(page.title)}" />
  <meta name="twitter:description" content="${escape(page.description)}" />
  <meta name="twitter:image" content="${origin}/assets/icons/icon-512.png" />`;
}
function structuredData(page) {
  const site = { "@type": "WebSite", "@id": origin + "/#website", url: origin + "/", name: "Nschess", inLanguage: "en" };
  const webPage = { "@type": "WebPage", "@id": origin + page.path + "#webpage", url: origin + page.path, name: page.title, description: page.description, inLanguage: "en", isPartOf: { "@id": site["@id"] } };
  const graph = [site, webPage];
  if (page.path !== "/") graph.push({ "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Nschess", item: origin + "/" },
    { "@type": "ListItem", position: 2, name: page.label, item: origin + page.path }
  ] });
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`;
}
function renderPage(page) {
  const related = page.related.map((route) => pages.find((item) => item.path === route));
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#071220" />
  ${metadata(page)}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/discovery.css?v=seo-v1" />
  ${structuredData(page)}
</head><body>
  <a class="skip" href="#content">Skip to main content</a>
  <header><nav class="wrap navigation" aria-label="Main navigation"><a class="brand" href="/">Nschess<span>Chess platform</span></a><div><a href="/learn/">Learn</a><a href="/puzzles/">Puzzles</a><a href="/play-computer/">Play a computer</a><a href="/#top">Open app</a></div></nav></header>
  <main id="content" class="wrap" tabindex="-1">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Nschess</a><span aria-hidden="true"> / </span><span aria-current="page">${escape(page.label)}</span></nav>
    <article>
      <div class="hero"><p class="kicker">Learn · Practice · Understand</p><h1>${escape(page.heading)}</h1><p class="intro">${escape(page.intro)}</p><a class="button" href="/#${page.hash}">${escape(page.action)}</a><p class="app-note">Interactive chess boards use JavaScript. These guides are readable without it.</p></div>
      <div class="guide-grid">${page.sections.map(([heading, content]) => `<section><h2>${escape(heading)}</h2><p>${escape(content)}</p></section>`).join("\n")}</div>
    </article>
    <aside class="related" aria-labelledby="related-title"><h2 id="related-title">Continue your practice</h2><nav aria-label="Related chess guides">${related.map((item) => `<a href="${item.path}">${escape(item.label)} <span aria-hidden="true">→</span></a>`).join("\n")}</nav></aside>
  </main>
  <footer class="wrap"><a href="/">Nschess</a><nav aria-label="Policies"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/account-deletion.html">Account deletion</a></nav></footer>
</body></html>\n`;
}
module.exports = { origin, pages, legalPages, home, escape, metadata, structuredData, renderPage };
