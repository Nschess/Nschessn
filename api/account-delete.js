const { getSupabaseConfig, getSupabaseServiceRoleKey } = require("./_supabase");

function send(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

function getBearerToken(request) {
  const value = String(request?.headers?.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function readJson(response) {
  return response.json().catch(() => null);
}

async function verifyRequestUser(url, anonKey, token) {
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  const payload = await readJson(response);
  if (!response.ok || !payload?.id) {
    const error = new Error(payload?.message || payload?.error_description || "Your session has expired. Please sign in again.");
    error.status = 401;
    throw error;
  }
  return payload;
}

async function removeLeaderboardEntry(url, serviceRoleKey, userId) {
  const response = await fetch(`${url}/rest/v1/leaderboard_entries?public_id=eq.${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: "return=minimal" }
  });
  if (response.ok) return;
  const payload = await readJson(response);
  // The leaderboard is optional, so a deployment without the table can still delete the account.
  if (response.status === 404 || payload?.code === "42P01") return;
  const error = new Error(payload?.message || payload?.error || "Could not remove the public leaderboard entry.");
  error.status = response.status || 500;
  throw error;
}

async function deleteAuthUser(url, serviceRoleKey, userId) {
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (response.ok) return;
  const payload = await readJson(response);
  const error = new Error(payload?.message || payload?.error || "Could not delete the online account.");
  error.status = response.status || 500;
  throw error;
}

module.exports = async (request, response) => {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  try {
    const token = getBearerToken(request);
    if (!token) return send(response, 401, { error: "Sign in before deleting an online account." });
    const { url, anonKey } = getSupabaseConfig();
    const serviceRoleKey = getSupabaseServiceRoleKey();
    const user = await verifyRequestUser(url, anonKey, token);
    await removeLeaderboardEntry(url, serviceRoleKey, user.id);
    await deleteAuthUser(url, serviceRoleKey, user.id);
    return send(response, 200, { deleted: true });
  } catch (error) {
    const unavailable = error?.code === "SUPABASE_SERVICE_ROLE_KEY_MISSING" || error?.code === "SUPABASE_NOT_CONFIGURED";
    return send(response, unavailable ? 503 : (error?.status || 500), {
      error: unavailable ? "Online account deletion is not configured on this deployment. Use the public deletion-request page." : (error?.message || "Account deletion failed."),
      code: error?.code || "ACCOUNT_DELETION_FAILED"
    });
  }
};