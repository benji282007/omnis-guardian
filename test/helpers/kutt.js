// Test harness: boot a real Kutt server against a fresh SQLite database,
// create the admin user and an API key, and hand back a small HTTP client.
// Used by the integration tests in test/ (added by Omnis Guardian; upstream
// Kutt has no automated tests).
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const net = require("node:net");

const ROOT = join(__dirname, "..", "..");
const ADMIN = { email: "admin@example.test", password: "Guardian-Test-Pass-1" };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, logs) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`Kutt exited early:\n${logs()}`);
    try {
      const res = await fetch(`${base}/api/v2/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Kutt did not become healthy:\n${logs()}`);
}

/**
 * Start Kutt. Returns { base, apiKey, request, stop }.
 * `request(method, path, { body, apiKey, headers })` returns { status, headers, json, text }.
 */
async function startKutt(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kutt-test-"));
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DEFAULT_DOMAIN: `localhost:${port}`,
    JWT_SECRET: "test-only-secret-not-used-anywhere-else",
    DB_CLIENT: "better-sqlite3",
    DB_FILENAME: join(dir, "kutt.sqlite"),
    REDIS_ENABLED: "false",
    ENABLE_RATE_LIMIT: "false",
    ...extraEnv
  };
  // A parent node:test runner would make child processes skip their own work.
  delete env.NODE_TEST_CONTEXT;

  const migrate = spawnSync(process.execPath, [require.resolve("knex/bin/cli.js"), "migrate:latest"], {
    cwd: ROOT,
    env,
    encoding: "utf8"
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}${migrate.stderr}`);

  let output = "";
  const child = spawn(process.execPath, ["server/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const abort = (err) => {
    // Never leave a server running if setup fails, or the test runner hangs.
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw err;
  };
  try {
    await waitForHealth(base, child, () => output);
  } catch (err) {
    abort(err);
  }

  async function request(method, path, { body, apiKey, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  let apiKey;
  try {
    const created = await request("POST", "/api/v2/auth/create-admin", { body: ADMIN });
    if (created.status !== 201) throw new Error(`create-admin failed: ${created.status} ${created.text}`);
    // create-admin's token has no user id (sub); log in for a usable session token.
    const login = await request("POST", "/api/v2/auth/login", { body: ADMIN });
    if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
    const key = await request("POST", "/api/v2/auth/apikey", { headers: { cookie: `token=${login.json.token}` } });
    if (key.status !== 201 && key.status !== 200) throw new Error(`apikey failed: ${key.status} ${key.text}`);
    apiKey = key.json.apikey;
  } catch (err) {
    abort(err);
  }

  async function stop() {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    rmSync(dir, { recursive: true, force: true });
  }

  return { base, apiKey, request, stop, admin: ADMIN, logs: () => output };
}

module.exports = { startKutt, ADMIN };
