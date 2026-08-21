const http = require("http");
const fs = require("fs");
const path = require("path");
const { discoverSupabaseConfig } = require("./e2e-config.cjs");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.E2E_PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav"
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const requested = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.resolve(root, `.${requested}`);
  return resolved.startsWith(root) ? resolved : null;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  if (String(request.url || "").split("?")[0] === "/api/auth-config") {
    const config = discoverSupabaseConfig();
    if (!config.hasUrl || !config.hasAnonKey) {
      sendJson(response, 503, {
        error: `Local E2E Supabase configuration is missing a public ${!config.hasUrl ? "URL" : "anon key"}. Set only the missing public value in .env.e2e or the process environment.`,
        code: "E2E_SUPABASE_NOT_CONFIGURED",
        missing: [!config.hasUrl ? "SUPABASE_URL" : "", !config.hasAnonKey ? "SUPABASE_PUBLISHABLE_KEY" : ""].filter(Boolean)
      });
      return;
    }
    sendJson(response, 200, { url: config.url, anonKey: config.anonKey });
    return;
  }
  const filePath = safePath(request.url);
  if (!filePath) {
    response.writeHead(400);
    response.end("Bad path");
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (!statError && stats.isDirectory()) {
      response.writeHead(403);
      response.end("Directory listing disabled");
      return;
    }
    const fallback = statError ? safePath("/index.html") : filePath;
    fs.readFile(fallback, (readError, data) => {
      if (readError) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": mime[path.extname(fallback).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
        "service-worker-allowed": "/"
      });
      response.end(data);
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Nschess E2E server listening on http://127.0.0.1:${port}`);
});

function close() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
