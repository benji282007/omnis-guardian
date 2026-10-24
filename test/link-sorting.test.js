const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startKutt } = require("./helpers/kutt");

let kutt;
before(async () => {
  kutt = await startKutt();
});
after(() => kutt?.stop());

test("links can be sorted by visit count", async () => {
  await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "https://example.com/1" } });
  await kutt.request("POST", "/api/v2/links", { apiKey: kutt.apiKey, body: { target: "https://example.com/2" } });
  const res = await kutt.request("GET", "/api/v2/links?sort=visit_count:desc", { apiKey: kutt.apiKey });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.length, 2);
});
