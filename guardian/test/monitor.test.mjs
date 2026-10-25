import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRuntime } from '../ci/monitor.mjs';

const config = JSON.parse(readFileSync(new URL('../gcp/runtime-config.json', import.meta.url), 'utf8'));
const DIGEST = 'sha256:c3f300be54f91cfe4ae5e3d92760c197233d54bfdbd9e3b786d30b9249213a66';
const deploy = { image: `us-central1-docker.pkg.dev/p/kutt/kutt@${DIGEST}` };

// Shapes follow `gcloud run services/revisions describe --format=json` (Knative serving v1).
function live({ digest = DIGEST, maxScale = '1', memory = '512Mi', traffic, labels } = {}) {
  return {
    service: {
      metadata: { labels: labels ?? { 'managed-by': 'omnis-guardian', commit: '3761a1c4' } },
      status: { url: 'https://kutt.example.run.app', traffic: traffic ?? [{ revisionName: 'kutt-00005-xud', percent: 100 }] }
    },
    revision: {
      metadata: {
        name: 'kutt-00005-xud',
        annotations: { 'autoscaling.knative.dev/minScale': '1', 'autoscaling.knative.dev/maxScale': maxScale }
      },
      spec: {
        containers: [
          {
            image: `us-central1-docker.pkg.dev/p/kutt/kutt@${digest}`,
            ports: [{ containerPort: 3000 }],
            resources: { limits: { cpu: '1', memory } },
            env: [{ name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'kutt-jwt-secret', key: 'latest' } } }]
          }
        ]
      }
    }
  };
}

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test('a service that matches the release and runtime-config.json passes every check', () => {
  const r = checkRuntime({ ...live(), deploy, config });
  assert.deepEqual(failed(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.servingRevision, 'kutt-00005-xud');
});

test('a hand edit in the console (max instances 1 -> 3) is reported as drift', () => {
  const r = checkRuntime({ ...live({ maxScale: '3' }), deploy, config });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ['max instances']);
  const c = r.checks.find((x) => x.name === 'max instances');
  assert.equal(c.expected, '1');
  assert.equal(c.actual, '3');
});

test('an image that was not the approved release is reported', () => {
  const r = checkRuntime({ ...live({ digest: 'sha256:0000' }), deploy, config });
  assert.deepEqual(failed(r), ['image digest is the last approved release']);
});

test('traffic split across revisions is reported', () => {
  const traffic = [
    { revisionName: 'kutt-00005-xud', percent: 50 },
    { revisionName: 'kutt-00003-vav', percent: 50 }
  ];
  const r = checkRuntime({ ...live({ traffic }), deploy, config });
  assert.ok(failed(r).includes('all traffic on one revision'));
});

test('missing settings count as drift, never as a pass', () => {
  const r = checkRuntime({ service: {}, revision: {}, deploy, config });
  assert.equal(r.ok, false);
  assert.ok(r.checks.every((c) => !c.ok));
  assert.ok(r.checks.some((c) => c.actual === 'missing'));
});

test('a removed label is reported', () => {
  const r = checkRuntime({ ...live({ labels: {} }), deploy, config });
  assert.deepEqual(failed(r), ['label managed-by']);
});
