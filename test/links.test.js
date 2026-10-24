const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startKutt } = require("./helpers/kutt");

let kutt;
before(async () => {
  kutt = await startKutt();
});
after(() => kutt?.stop());

test("health endpoint responds", async () => {
  const res = await kutt.request("GET", "/api/v2/health");
  assert.equal(res.status, 200);
  assert.equal(res.text, "OK");
});

test("creates a short link with an API key and redirects to the target", async () => {
  const created = await kutt.request("POST", "/api/v2/links", {
    apiKey: kutt.apiKey,
    body: { target: "https://about.gitlab.com/", description: "GitLab" }
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.target, "https://about.gitlab.com/");
  assert.match(created.json.address, /^[A-Za-z0-9_-]+$/);

  const redirect = await kutt.request("GET", `/${created.json.address}`, { headers: { accept: "text/html" } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://about.gitlab.com/");
});

test("anonymous link creation is refused by default", async () => {
  const res = await kutt.request("POST", "/api/v2/links", { body: { target: "https://example.com/" } });
  assert.equal(res.status, 401);
});

test("invalid targets are rejected", async () => {
  const res = await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "not a url" } });
  assert.equal(res.status, 400);
});

test("lists links and searches by description", async () => {
  await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "https://example.com/a", description: "alpha docs" } });
  await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "https://example.com/b", description: "beta notes" } });
  const all = await kutt.request("GET", "/api/v2/links?limit=50", { apiKey: kutt.apiKey });
  assert.equal(all.status, 200, all.text);
  assert.ok(all.json.data.length >= 2);
  const found = await kutt.request("GET", "/api/v2/links?search=alpha", { apiKey: kutt.apiKey });
  assert.deepEqual(found.json.data.map((l) => l.description), ["alpha docs"]);
});

test("search input is treated as text, not SQL", async () => {
  const res = await kutt.request("GET", `/api/v2/links?search=${encodeURIComponent("' OR 1=1 --")}`, { apiKey: kutt.apiKey });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 0);
});

test("deletes a link", async () => {
  const created = await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "https://example.com/delete-me" } });
  const del = await kutt.request("DELETE", `/api/v2/links/${created.json.id}`, { apiKey: kutt.apiKey });
  assert.equal(del.status, 200, del.text);
  // Kutt sends unknown or deleted addresses to its 404 page.
  const gone = await kutt.request("GET", `/${created.json.address}`, { headers: { accept: "text/html" } });
  assert.equal(gone.headers.get("location"), "/404");
});
