const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function readDiscoverableValues() {
  const files = [
    path.join(root, ".env.local"),
    path.join(root, ".env"),
    path.join(root, ".env.example")
  ];
  const values = {};
  for (const file of files) {
    const fileValues = parseEnvFile(file);
    for (const [key, value] of Object.entries(fileValues)) {
      if (!String(values[key] || "").trim() && String(value || "").trim()) values[key] = value;
    }
  }
  const projectRefFile = path.join(root, "supabase", ".temp", "project-ref");
  const projectRef = fs.existsSync(projectRefFile) ? fs.readFileSync(projectRefFile, "utf8").trim() : "";
  return { values, projectRef };
}

function firstNonEmpty(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function discoverSupabaseConfig() {
  const { values, projectRef } = readDiscoverableValues();
  const url = firstNonEmpty(
    process.env.E2E_SUPABASE_URL,
    process.env.SUPABASE_URL,
    values.E2E_SUPABASE_URL,
    values.SUPABASE_URL,
    projectRef ? `https://${projectRef}.supabase.co` : ""
  ).replace(/\/$/, "");
  const anonKey = firstNonEmpty(
    process.env.E2E_SUPABASE_ANON_KEY,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    values.E2E_SUPABASE_ANON_KEY,
    values.SUPABASE_PUBLISHABLE_KEY,
    values.SUPABASE_ANON_KEY
  );
  const urlSource = process.env.E2E_SUPABASE_URL || process.env.SUPABASE_URL
    ? "environment"
    : values.E2E_SUPABASE_URL || values.SUPABASE_URL
      ? "project env file"
      : projectRef
        ? "supabase project-ref"
        : "missing";
  const keySource = process.env.E2E_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY
    ? "environment"
    : values.E2E_SUPABASE_ANON_KEY || values.SUPABASE_PUBLISHABLE_KEY || values.SUPABASE_ANON_KEY
      ? "project env file"
      : "missing";
  return {
    url,
    anonKey,
    urlSource,
    keySource,
    hasUrl: Boolean(url),
    hasAnonKey: Boolean(anonKey)
  };
}

module.exports = { discoverSupabaseConfig, parseEnvFile };
