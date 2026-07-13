const { supabaseRequest } = require("./_supabase");
const namePattern = /^[A-Za-z0-9_-]{3,20}$/;
const idPattern = /^[A-Za-z0-9_-]{8,80}$/;

function send(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

function number(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function normalizeEntry(input = {}) {
  const publicId = String(input.publicId || "").trim();
  const username = String(input.username || "").trim();
  if (!idPattern.test(publicId) || !namePattern.test(username)) return null;
  if (/(bot|npc|test|dummy|campaign|rival|guest)/i.test(username)) return null;
  const statistics = input.statistics && typeof input.statistics === "object" ? input.statistics : {};
  return {
    publicId,
    username,
    countryFlag: String(input.countryFlag || "").slice(0, 8),
    title: String(input.title || "").slice(0, 48),
    puzzleRating: number(input.puzzleRating, 400, 3000),
    gameRating: number(input.gameRating, 400, 3000),
    achievements: Array.isArray(input.achievements) ? input.achievements.slice(0, 12).map((item) => String(item).slice(0, 48)) : [],
    statistics: {
      gamesPlayed: number(statistics.gamesPlayed, 0, 1000000),
      wins: number(statistics.wins, 0, 1000000),
      puzzlesSolved: number(statistics.puzzlesSolved, 0, 1000000),
      puzzleAccuracy: number(statistics.puzzleAccuracy, 0, 100),
      lessonsCompleted: number(statistics.lessonsCompleted, 0, 1000000),
      cleanGames: number(statistics.cleanGames, 0, 1000000),
      bossClears: number(statistics.bossClears, 0, 1000000)
    },
    updatedAt: String(input.updatedAt || new Date().toISOString())
  };
}

async function readEntries() {
  const rows = await supabaseRequest("leaderboard_entries?select=public_id,username,country_flag,title,puzzle_rating,game_rating,achievements,statistics,updated_at&order=updated_at.desc&limit=500");
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeEntry({
      publicId: row.public_id,
      username: row.username,
      countryFlag: row.country_flag,
      title: row.title,
      puzzleRating: row.puzzle_rating,
      gameRating: row.game_rating,
      achievements: row.achievements,
      statistics: row.statistics,
      updatedAt: row.updated_at
    }))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 500);
}

module.exports = async (request, response) => {
  try {
    if (request.method === "GET") return send(response, 200, { entries: await readEntries() });
    if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." });
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    const entry = normalizeEntry(body?.entry || body);
    if (!entry) return send(response, 400, { error: "A valid registered player entry is required." });
    const row = {
      public_id: entry.publicId,
      username: entry.username,
      country_flag: entry.countryFlag,
      title: entry.title,
      puzzle_rating: entry.puzzleRating,
      game_rating: entry.gameRating,
      achievements: entry.achievements,
      statistics: entry.statistics,
      updated_at: entry.updatedAt
    };
    await supabaseRequest("leaderboard_entries?on_conflict=public_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row)
    });
    return send(response, 200, { entry });
  } catch (error) {
    const status = error?.code === "SUPABASE_NOT_CONFIGURED" ? 503 : (error?.status || 500);
    return send(response, status, { error: error?.message || "Leaderboard storage failed.", code: error?.code || "LEADERBOARD_STORAGE_ERROR" });
  }
};
