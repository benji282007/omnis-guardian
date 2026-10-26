// Inputs below are hand-written in the shape of GitLab REST API v4 responses.
// They test the mapping only and are never shown in the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES,
  mapStages,
  releaseGateState,
  isGuardianMr,
  summariseGuardianMr,
  latestJobs,
  formatAgo,
  summariseMonitorRuns,
  summariseMonitorResult,
  summariseIncident,
  incidentStory
} from '../model.js';

const job = (id, name, status, extra = {}) => ({ id, name, status, web_url: `https://gitlab.example/-/jobs/${id}`, ...extra });

test('every stage is backed by a real job or by the Duo fix MR', () => {
  for (const s of STAGES) assert.ok(s.source === 'duo' || (Array.isArray(s.jobs) && s.jobs.length > 0), s.key);
  assert.equal(STAGES.length, 9);
});

test('with no data, every stage says so instead of guessing', () => {
  const stages = mapStages({});
  assert.ok(stages.every((s) => s.status === 'no-data'));
});

test('stages take the status of their jobs, using the latest retry', () => {
  const jobs = [
    job(1, 'unit_tests', 'failed'),
    job(5, 'unit_tests', 'success'),
    job(2, 'security_gate', 'failed'),
    job(3, 'build_image', 'success'),
    job(4, 'release_gate', 'manual')
  ];
  const byKey = Object.fromEntries(mapStages({ jobs, pipeline: { id: 9 } }).map((s) => [s.key, s]));
  assert.equal(byKey.verify.status, 'success');
  assert.equal(byKey.secure.status, 'failed');
  assert.equal(byKey.secure.tone, 'fail');
  assert.equal(byKey.release.status, 'manual');
  assert.equal(byKey.release.tone, 'gate');
  assert.equal(byKey.monitor.status, 'no-data');
});

test('govern fails if provenance was not verified, even when the job passed', () => {
  const jobs = [job(3, 'verify_signatures', 'success')];
  const govern = (evidence) => mapStages({ jobs, pipeline: {}, evidence }).find((s) => s.key === 'govern');
  assert.equal(govern({ provenance: { verified: true }, signature: { verified: true } }).status, 'success');
  assert.match(govern({ provenance: { verified: true }, signature: { verified: false } }).detail, /unsigned/);
  assert.equal(govern({ provenance: { verified: false } }).status, 'failed');
});

test('Duo stages reflect the guardian MR', () => {
  const mr = { iid: 7, state: 'opened', web_url: 'https://gitlab.example/-/merge_requests/7' };
  const plan = mapStages({ guardianMr: mr }).find((s) => s.key === 'create');
  assert.equal(plan.status, 'success');
  assert.equal(plan.url, mr.web_url);
});

test('release gate states', () => {
  assert.equal(releaseGateState([]).state, 'not-run');
  assert.equal(releaseGateState([job(1, 'release_gate', 'manual')]).state, 'awaiting');
  const approved = releaseGateState([
    job(1, 'release_gate', 'success', { user: { username: 'reviewer' }, finished_at: '2026-10-25T10:00:00Z' }),
    job(2, 'publish_release', 'success')
  ]);
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approver, 'reviewer');
  assert.equal(approved.label, 'Approved and released');
  assert.equal(releaseGateState([job(1, 'release_gate', 'failed', { user: { username: 'mallory' } })]).state, 'blocked');
});

test('guardian MRs are recognised by branch, and only verified when all checks pass', () => {
  assert.equal(isGuardianMr({ source_branch: 'guardian/fix-123' }), true);
  assert.equal(isGuardianMr({ source_branch: 'feature/x' }), false);
  const mr = { iid: 3, title: 'Guardian: fix', web_url: 'u', state: 'opened', source_branch: 'guardian/fix-1', target_branch: 'feature/x', author: { username: 'ai-omnis' } };
  const pass = summariseGuardianMr(mr, [job(1, 'regression_proof', 'success'), job(2, 'unit_tests', 'success'), job(3, 'security_gate', 'success')], { verdict: 'proven', reason: 'r', testFiles: ['a'] });
  assert.equal(pass.verified, true);
  assert.equal(pass.proof.verdict, 'proven');
  const partial = summariseGuardianMr(mr, [job(1, 'regression_proof', 'failed'), job(2, 'unit_tests', 'success')]);
  assert.equal(partial.verified, false);
  assert.equal(partial.checks.security_gate, 'not run');
});

test('latestJobs and formatAgo', () => {
  assert.equal(latestJobs([job(1, 'a', 'failed'), job(2, 'a', 'success')]).get('a').id, 2);
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(formatAgo('2026-10-25T11:58:00Z', now), '2m ago');
  assert.equal(formatAgo(null, now), '—');
});

test('monitor combines the deploy with the latest hourly live check', () => {
  const jobs = [job(1, 'deploy_production', 'success'), job(2, 'monitor_production', 'failed')];
  const monitor = mapStages({ jobs, pipeline: {} }).find((s) => s.key === 'monitor');
  assert.equal(monitor.status, 'failed');
  assert.match(monitor.detail, /monitor_production: failed/);
});

test('configure shows live drift from the monitor result', () => {
  const jobs = [job(1, 'config_check', 'success')];
  const configure = (runtime) => mapStages({ jobs, pipeline: {}, runtime }).find((s) => s.key === 'configure');
  assert.equal(configure(null).status, 'success');
  const clean = configure({ checks: [{ name: 'cpu', ok: true }] });
  assert.equal(clean.status, 'success');
  assert.match(clean.detail, /live config matches release/);
  const drifted = configure({ checks: [{ name: 'max instances', ok: false }, { name: 'cpu', ok: true }] });
  assert.equal(drifted.status, 'failed');
  assert.match(drifted.detail, /drift: max instances/);
});

test('monitor runs become a pass/fail timeline', () => {
  const s = summariseMonitorRuns([
    { id: 3, status: 'success', created_at: '2026-10-26T06:35:00Z', web_url: 'u3' },
    { id: 2, status: 'failed', created_at: '2026-10-25T14:07:00Z', web_url: 'u2' }
  ]);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.runs.map((r) => r.tone), ['pass', 'fail']);
});

test('the newest monitor result is summarised, drift spelled out', () => {
  const r = summariseMonitorResult({
    ok: false,
    runtime: { checks: [{ name: 'cpu', ok: true }, { name: 'max instances', ok: false, expected: '1', actual: '2' }] },
    smoke: { probes: [{ ok: true }, { ok: true }] }
  });
  assert.equal(r.checksPassed, 1);
  assert.equal(r.checksTotal, 2);
  assert.equal(r.probesPassed, 2);
  assert.deepEqual(r.drift, ['max instances: expected 1, found 2']);
  assert.equal(summariseMonitorResult(null), null);
});

test('an incident records whether the Duo flow opened it and who closed it', () => {
  const i = summariseIncident({
    iid: 1, title: 'Omnis Guardian incident: drift', web_url: 'w', state: 'closed',
    created_at: '2026-10-25T14:09:46Z', closed_at: '2026-10-25T14:19:56Z',
    author: { username: 'ai-omnis-guardian-omnis-guardian', name: 'Omnis Guardian' },
    closed_by: { username: 'fl4sh28', name: 'Benjamin Chacko' }
  }, 'ai-omnis-guardian-omnis-guardian');
  assert.equal(i.openedByDuo, true);
  assert.equal(i.closedBy, 'Benjamin Chacko');
  assert.equal(summariseIncident({ iid: 2, author: { username: 'someone' } }, 'ai-omnis-guardian-omnis-guardian').openedByDuo, false);
  // A look-alike name must not pass as the flow, and without a configured account nothing does.
  assert.equal(summariseIncident({ iid: 3, author: { username: 'ai-omnis-guardian-omnis-guardian-fake' } }, 'ai-omnis-guardian-omnis-guardian').openedByDuo, false);
  assert.equal(summariseIncident({ iid: 4, author: { username: 'ai-omnis-guardian-omnis-guardian' } }).openedByDuo, false);
});

test('the incident story is built from the real runs around it', () => {
  const incident = { iid: 1, url: 'i', openedByDuo: true, openedAt: '2026-10-25T14:09:46Z', closedAt: '2026-10-25T14:19:56Z', closedBy: 'Benjamin Chacko' };
  const runs = [
    { status: 'success', created_at: '2026-10-25T14:16:13Z', web_url: 'pass' },
    { status: 'failed', created_at: '2026-10-25T14:07:42Z', web_url: 'fail' },
    { status: 'success', created_at: '2026-10-25T14:00:58Z', web_url: 'before' }
  ];
  const s = incidentStory(incident, runs);
  assert.deepEqual(s.map((x) => x.url), ['fail', 'i', 'pass', 'i']);
  assert.ok(s.every((x) => x.done));
  assert.match(s[1].label, /Duo flow opened incident #1/);
  assert.match(s[3].label, /Closed by Benjamin Chacko/);
});

test('a story with missing records says so instead of guessing', () => {
  const s = incidentStory({ iid: 2, url: 'i', openedByDuo: true, openedAt: '2026-10-25T14:09:46Z', closedAt: null }, []);
  assert.equal(s[0].done, false);
  assert.equal(s[2].done, false);
  assert.match(s[3].label, /Awaiting a person/);
});
