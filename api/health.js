const { supabaseRequest } = require("./_supabase");

module.exports = async (_request, response) => {
  try {
    await supabaseRequest("profiles?select=id&limit=1");
    response.status(200).setHeader("Cache-Control", "no-store").json({ ok: true, service: "supabase", tables: ["profiles"] });
  } catch (error) {
    response.status(error?.status || 503).setHeader("Cache-Control", "no-store").json({
      ok: false,
      service: "supabase",
      code: error?.code || "SUPABASE_UNAVAILABLE",
      error: error?.message || "Supabase is unavailable."
    });
  }
};
