const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { assertApprovedE2EProject, assertApprovedBrowserConfig } = require("./e2e-config.cjs");

// A response from an occupied port is not proof that our server started.
// Match both the per-spawn nonce and the reviewed backend before any browser opens.
async function startE2EServer({ root, baseUrl, stdio, timeoutMs = 10000 }) {
  assertApprovedE2EProject();
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("E2E server requires its own local HTTP origin.");
  }
  const instanceId = crypto.randomUUID();
  const server = spawn(process.execPath, [path.join(root, "scripts", "e2e-server.cjs")], {
    cwd: root, stdio,
    env: { ...process.env, E2E_PORT: origin.port || "80", E2E_SERVER_INSTANCE_ID: instanceId }
  });
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      let request;
      let retryTimer;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(deadlineTimer);
        clearTimeout(retryTimer);
        request?.destroy();
        server.removeListener("error", onError);
        server.removeListener("exit", onExit);
        if (error) reject(error); else resolve();
      };
      const onError = () => finish(new Error("Spawned E2E server could not start."));
      const onExit = () => finish(new Error("Spawned E2E server exited before readiness."));
      const deadlineTimer = setTimeout(() => finish(new Error("Timed out verifying the spawned E2E server.")), timeoutMs);
      server.once("error", onError);
      server.once("exit", onExit);
      const attempt = () => {
        if (done) return;
        request = http.get(new URL("/api/auth-config", origin), (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16384) finish(new Error("Unexpected E2E server readiness response."));
          });
          response.on("error", onError);
          response.on("end", () => {
            if (done) return;
            try {
              if (response.statusCode !== 200) throw new Error("E2E server auth-config is not ready (expected HTTP 200).");
              const config = JSON.parse(body);
              if (config.e2eServerInstance !== instanceId) throw new Error("E2E server instance mismatch; refusing an occupied or unexpected server.");
              assertApprovedBrowserConfig(config);
              if (server.exitCode !== null) throw new Error("Spawned E2E server is no longer running.");
              finish();
            } catch (error) { finish(error); }
          });
        });
        request.on("error", (error) => {
          if (done) return;
          if (error.code !== "ECONNREFUSED") return finish(new Error("E2E server readiness request failed."));
          retryTimer = setTimeout(attempt, 100);
        });
        request.setTimeout(1000, () => finish(new Error("E2E server readiness request stalled.")));
      };
      attempt();
    });
    return server;
  } catch (error) {
    server.kill();
    throw error;
  }
}

module.exports = { startE2EServer };
