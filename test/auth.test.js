const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startKutt } = require("./helpers/kutt");

let kutt;
before(async () => {
  kutt = await startKutt();
});
after(() => kutt?.stop());

test("a second admin cannot be created once a user exists", async () => {
  const res = await kutt.request("POST", "/api/v2/auth/create-admin", {
    body: { email: "intruder@example.test", password: "Another-Pass-123" }
  });
  assert.equal(res.status, 400);
});

test("login rejects a wrong password", async () => {
  const res = await kutt.request("POST", "/api/v2/auth/login", { body: { email: kutt.admin.email, password: "wrong-password-1" } });
  assert.equal(res.status, 401);
});

test("login with the right password returns a token", async () => {
  const res = await kutt.request("POST", "/api/v2/auth/login", { body: kutt.admin });
  assert.equal(res.status, 200, res.text);
  assert.match(res.json.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
});

test("API calls without a key are unauthorized", async () => {
  assert.equal((await kutt.request("GET", "/api/v2/links")).status, 401);
  assert.equal((await kutt.request("GET", "/api/v2/links", { apiKey: "not-a-real-key" })).status, 401);
});

test("admin endpoints accept the admin's key", async () => {
  const res = await kutt.request("GET", "/api/v2/users/admin?limit=5", { apiKey: kutt.apiKey });
  assert.ok([200, 404].includes(res.status), `unexpected ${res.status}: ${res.text.slice(0, 200)}`);
});
