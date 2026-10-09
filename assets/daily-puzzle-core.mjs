export const DAILY_STORAGE_KEY = "nschess.dailyPuzzle.v1";
export const DAILY_STATE_VERSION = 1;

const DAY_MS = 86400000;
const MAX_DAYS = 400;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function utcDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("A valid date is required.");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function utcDayNumber(dayKey) {
  if (!DAY_KEY.test(String(dayKey))) return null;
  const [year, month, day] = dayKey.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  if (utcDayKey(new Date(timestamp)) !== dayKey) return null;
  return Math.floor(timestamp / DAY_MS);
}

export function selectDailyPuzzle(dayKey, puzzles) {
  const day = utcDayNumber(dayKey);
  if (day === null || !Array.isArray(puzzles) || puzzles.length === 0) return null;
  return puzzles[((day % puzzles.length) + puzzles.length) % puzzles.length];
}

function emptyState() {
  return { version: DAILY_STATE_VERSION, days: {} };
}

export function parseDailyState(raw) {
  if (!raw) return { state: emptyState(), recovered: false };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || parsed.version !== DAILY_STATE_VERSION || !parsed.days || typeof parsed.days !== "object" || Array.isArray(parsed.days)) {
      return { state: emptyState(), recovered: true };
    }
    const entries = Object.entries(parsed.days)
      .filter(([key, value]) => utcDayNumber(key) !== null && value && typeof value === "object" && !Array.isArray(value))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_DAYS);
    const days = {};
    for (const [key, value] of entries) {
      const attempts = Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? Math.min(value.attempts, 999) : 0;
      const wrong = Number.isSafeInteger(value.wrong) && value.wrong >= 0 ? Math.min(value.wrong, attempts) : 0;
      const completed = value.completed === true && attempts > 0;
      days[key] = {
        attempts,
        wrong,
        completed,
        assisted: completed && value.assisted === true
      };
    }
    return { state: { version: DAILY_STATE_VERSION, days }, recovered: false };
  } catch {
    return { state: emptyState(), recovered: true };
  }
}

export function recordDailyAttempt(state, dayKey, correct, assisted = false) {
  if (utcDayNumber(dayKey) === null) throw new TypeError("A valid UTC day key is required.");
  const current = parseDailyState(state).state;
  const prior = current.days[dayKey] || { attempts: 0, wrong: 0, completed: false, assisted: false };
  if (prior.completed) return current;
  const next = {
    attempts: Math.min(999, prior.attempts + 1),
    wrong: Math.min(999, prior.wrong + (correct ? 0 : 1)),
    completed: Boolean(correct),
    assisted: Boolean(correct) && (prior.assisted || Boolean(assisted))
  };
  return parseDailyState({ version: DAILY_STATE_VERSION, days: { ...current.days, [dayKey]: next } }).state;
}

export function dailyStreak(state, todayKey = utcDayKey()) {
  const current = parseDailyState(state).state;
  let day = utcDayNumber(todayKey);
  if (day === null) return 0;
  const dates = new Set(Object.entries(current.days).filter(([, value]) => value.completed).map(([key]) => key));
  if (!dates.has(todayKey)) {
    day -= 1;
    if (!dates.has(utcDayKey(new Date(day * DAY_MS)))) return 0;
  }
  let streak = 0;
  while (dates.has(utcDayKey(new Date(day * DAY_MS)))) {
    streak += 1;
    day -= 1;
  }
  return streak;
}

export function nextUtcMidnight(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("A valid date is required.");
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
