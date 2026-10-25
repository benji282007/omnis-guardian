const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startKutt } = require("./helpers/kutt");

// A browser user agent, so the redirect handler counts the visit (bots are skipped).
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

let kutt;
// Links in creation order; visits[i] is how many times links[i] is opened.
let links;
const visits = [0, 2, 1, 2];

function idsOf(res) {
  return res.json.data.map((link) => link.id);
}

async function list(query) {
  const res = await kutt.request("GET", `/api/v2/links?${query}`, { apiKey: kutt.apiKey });
  assert.equal(res.status, 200, res.text);
  return res;
}

before(async () => {
  kutt = await startKutt();
  links = [];
  for (let i = 0; i < visits.length; i += 1) {
    const res = await kutt.request("POST", "/api/v2/links", {
      apiKey: kutt.apiKey,
      body: { target: `https://example.com/visits-${i}` }
    });
    assert.equal(res.status, 201, res.text);
    links.push(res.json);
  }
  for (let i = 0; i < visits.length; i += 1) {
    for (let v = 0; v < visits[i]; v += 1) {
      const res = await kutt.request("GET", `/${links[i].address}`, { headers: { "user-agent": BROWSER_UA } });
      assert.equal(res.status, 302, res.text);
    }
  }
  // Visits are recorded asynchronously; wait until every count has landed.
  const expected = visits.reduce((a, b) => a + b, 0);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await list("limit=50");
    const total = res.json.data.reduce((sum, link) => sum + Number(link.visit_count), 0);
    if (total === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("visit counts were not recorded in time");
});
after(() => kutt?.stop());

test("links can be sorted by visit count, with ties broken by newest first", async () => {
  const res = await list("sort=visit_count:desc");
  // 2 visits: links 3 and 1 (newest first), then 1 visit: link 2, then 0 visits: link 0.
  assert.deepEqual(idsOf(res), [links[3].id, links[1].id, links[2].id, links[0].id]);
});

test("ascending visit count reverses the order of the counts", async () => {
  const res = await list("sort=visit_count:asc");
  assert.deepEqual(idsOf(res), [links[0].id, links[2].id, links[3].id, links[1].id]);
});

test("pagination over tied visit counts is stable", async () => {
  const pages = [];
  for (let skip = 0; skip < visits.length; skip += 1) {
    pages.push(...idsOf(await list(`sort=visit_count:desc&limit=1&skip=${skip}`)));
  }
  const full = idsOf(await list("sort=visit_count:desc"));
  assert.deepEqual(pages, full);
});

test("a repeated sort parameter falls back to the default order", async () => {
  const res = await list("sort=visit_count:asc&sort=created_at:asc");
  assert.deepEqual(idsOf(res), links.map((link) => link.id).reverse());
});
