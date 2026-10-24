const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startKutt } = require("../helpers/kutt");

let kutt;
let createdIds;

before(async () => {
  kutt = await startKutt();
  createdIds = [];
  for (let i = 1; i <= 3; i += 1) {
    const res = await kutt.request("POST", "/api/v2/links", {
      apiKey: kutt.apiKey,
      body: { target: `https://example.com/sort-${i}` }
    });
    assert.equal(res.status, 201, res.text);
    createdIds.push(res.json.id);
  }
});
after(() => kutt?.stop());

function idsOf(res) {
  return res.json.data.map((link) => link.id);
}

const defaultOrder = () => [...createdIds].sort((a, b) => b - a);

test("an unknown sort column falls back to the default order", async () => {
  const res = await kutt.request("GET", "/api/v2/links?sort=not_a_column:desc", { apiKey: kutt.apiKey });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(idsOf(res), defaultOrder());
});

test("an unknown sort direction falls back to the default order", async () => {
  const res = await kutt.request("GET", "/api/v2/links?sort=visit_count:sideways", { apiKey: kutt.apiKey });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(idsOf(res), defaultOrder());
});

test("a valid sort still works", async () => {
  const res = await kutt.request("GET", "/api/v2/links?sort=created_at:asc", { apiKey: kutt.apiKey });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([...idsOf(res)].sort((a, b) => a - b), [...createdIds].sort((a, b) => a - b));
  const times = res.json.data.map((link) => new Date(link.created_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});
