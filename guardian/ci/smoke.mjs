#!/usr/bin/env node
// Smoke-test a running Kutt instance by URL: the CI image (as a service
// container), a Cloud Run candidate revision, or production after promotion.
// The checks are real user journeys and leave nothing behind (the test link is
// deleted). On a fresh instance it creates the admin account first, so the
// one-time setup endpoint is never left open.
//
// Usage: node guardian/ci/smoke.mjs --url https://... [--out smoke-result.json] [--expect-revision <sha>]
// Env:   KUTT_ADMIN_EMAIL, KUTT_ADMIN_PASSWORD (required)
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function runSmoke({ url, email, password, fetchImpl = fetch, attempts = 40 }) {
  const base = url.replace(/\/$/, '');
  const probes = [];
  const call = (method, path, { body, headers = {} } = {}) =>
    fetchImpl(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
  const probe = async (name, fn) => {
    const t = performance.now();
    try {
      probes.push({ name, ok: true, detail: await fn(), ms: Math.round(performance.now() - t) });
    } catch (err) {
      probes.push({ name, ok: false, detail: err.message, ms: Math.round(performance.now() - t) });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  let ready = false;
  for (let i = 0; i < attempts && !ready; i += 1) {
    try {
      ready = (await call('GET', '/api/v2/health')).ok;
    } catch {
      // not up yet
    }
    if (!ready) await new Promise((r) => setTimeout(r, 1500));
  }

  await probe('health endpoint returns OK', async () => {
    const res = await call('GET', '/api/v2/health');
    expect(res.status === 200, `HTTP ${res.status}`);
    return 'HTTP 200';
  });

  await probe('admin account exists (setup endpoint closed)', async () => {
    const res = await call('POST', '/api/v2/auth/create-admin', { body: { email, password } });
    // 201: we just created it on a fresh instance. 400: it already existed.
    expect(res.status === 201 || res.status === 400, `HTTP ${res.status}`);
    const again = await call('POST', '/api/v2/auth/create-admin', { body: { email: 'other@example.test', password: 'Other-Pass-12345' } });
    expect(again.status === 400, `second create-admin returned HTTP ${again.status}`);
    return res.status === 201 ? 'created on fresh instance' : 'already present';
  });

  let cookie = null;
  await probe('admin can log in', async () => {
    const res = await call('POST', '/api/v2/auth/login', { body: { email, password } });
    expect(res.status === 200, `HTTP ${res.status}`);
    cookie = `token=${(await res.json()).token}`;
    return 'HTTP 200';
  });

  await probe('API refuses requests without credentials', async () => {
    const res = await call('GET', '/api/v2/links');
    expect(res.status === 401, `HTTP ${res.status}`);
    return 'HTTP 401';
  });

  await probe('short link round trip (create → redirect → delete)', async () => {
    expect(cookie, 'no session');
    const created = await call('POST', '/api/v2/links', { body: { target: 'https://about.gitlab.com/' }, headers: { cookie } });
    expect(created.status === 201, `create HTTP ${created.status}`);
    const link = await created.json();
    const redirect = await call('GET', `/${link.address}`, { headers: { accept: 'text/html' } });
    expect(redirect.status === 302 && redirect.headers.get('location') === 'https://about.gitlab.com/', `redirect HTTP ${redirect.status} → ${redirect.headers.get('location')}`);
    const del = await call('DELETE', `/api/v2/links/${link.id}`, { headers: { cookie } });
    expect(del.status === 200, `delete HTTP ${del.status}`);
    return `/${link.address} → 302`;
  });

  return { ok: probes.every((p) => p.ok), url: base, probes, checkedAt: new Date().toISOString() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const url = arg('--url');
  const { KUTT_ADMIN_EMAIL: email, KUTT_ADMIN_PASSWORD: password } = process.env;
  if (!url || !email || !password) {
    console.error('usage: smoke.mjs --url <url> with KUTT_ADMIN_EMAIL and KUTT_ADMIN_PASSWORD set');
    process.exit(2);
  }
  const result = await runSmoke({ url, email, password });
  writeFileSync(arg('--out', 'smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
  for (const p of result.probes) console.log(`${p.ok ? 'PASS' : 'FAIL'}  ${p.name} (${p.ms} ms) ${p.detail ?? ''}`);
  console.log(result.ok ? `SMOKE TEST PASSED for ${url}` : `SMOKE TEST FAILED for ${url}`);
  process.exitCode = result.ok ? 0 : 1;
}
