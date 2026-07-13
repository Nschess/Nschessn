const { getSupabaseConfig } = require("./_supabase");

module.exports = (_request, response) => {
  try {
    const { url, anonKey } = getSupabaseConfig();
    response.status(200).setHeader("Cache-Control", "no-store").json({ url, anonKey });
  } catch (error) {
    response.status(503).setHeader("Cache-Control", "no-store").json({
      error: error?.message || "Supabase is unavailable.",
      code: error?.code || "SUPABASE_NOT_CONFIGURED"
    });
  }
};
