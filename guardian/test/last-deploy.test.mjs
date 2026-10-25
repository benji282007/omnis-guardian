import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLastDeploy } from '../ci/last-deploy.mjs';

// A fake GitLab API: push pipelines newest first, their jobs, and job artifacts by job id.
function fakeApi({ pipelines, jobs, artifacts }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const path = u.pathname.replace(/^.*\/projects\/[^/]+/, '');
    let body;
    if (path === '/pipelines') body = Number(u.searchParams.get('page')) === 1 ? pipelines : [];
    else if (/^\/pipelines\/\d+\/jobs$/.test(path)) body = jobs[path.split('/')[2]] ?? [];
    else if (/^\/jobs\/\d+\/artifacts\/deploy-result\.json$/.test(path)) body = artifacts[path.split('/')[2]];
    return body === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const api = { apiUrl: 'https://gitlab.example/api/v4', projectId: 'g/p', ref: 'main' };

test('skips release pipelines without a successful deploy and reads the artifact by job id', async () => {
  const { fetchImpl, calls } = fakeApi({
    pipelines: [{ id: 3, iid: 78 }, { id: 2, iid: 70 }],
    jobs: {
      3: [{ id: 31, name: 'deploy_production', status: 'created' }],
      2: [{ id: 21, name: 'deploy_production', status: 'failed' }, { id: 22, name: 'deploy_production', status: 'success' }]
    },
    artifacts: { 22: { status: 'deployed', revision: 'kutt-00005-xud' } }
  });
  const found = await findLastDeploy({ ...api, fetchImpl });
  assert.equal(found.result.revision, 'kutt-00005-xud');
  assert.equal(found.job.id, 22);
  assert.equal(found.pipeline.iid, 70);
  assert.ok(calls[0].includes('source=push'), 'only release (push) pipelines, never scheduled monitor runs');
  assert.ok(calls.every((c) => !c.includes('/jobs/artifacts/main')), 'never the "latest artifact on main" URL');
});

test('returns null when no deploy has ever succeeded', async () => {
  const { fetchImpl } = fakeApi({ pipelines: [{ id: 1, iid: 2 }], jobs: { 1: [] }, artifacts: {} });
  assert.equal(await findLastDeploy({ ...api, fetchImpl }), null);
});
