import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, jobCarbon, coefficients, machineFor } from '../ci/carbon-report.mjs';

const job = (name, duration, extra = {}) => ({ name, stage: 'verify', status: 'success', duration, finished_at: '2026-10-25T10:00:00Z', tag_list: [], ...extra });

test('one hour on the default small runner matches a hand calculation', () => {
  const c = coefficients({});
  const r = jobCarbon(job('x', 3600), c);
  // CPU: 2 × (1.34 + 0.5 × 3.64) = 6.32 W; memory 8 × 0.392 = 3.136 W; total 9.456 W × 1.1 PUE
  assert.ok(Math.abs(r.kwh - 0.0104016) < 1e-9, String(r.kwh));
  assert.ok(Math.abs(r.operationalG - 5.2008) < 1e-6, String(r.operationalG));
  // Embodied: 1,200 kg × (1 h / 35,040 h) × (2 / 64)
  assert.ok(Math.abs(r.embodiedG - 1.0702054794520548) < 1e-9, String(r.embodiedG));
});

test('machine size follows the runner tag', () => {
  assert.equal(machineFor(job('x', 1)).vcpus, 2);
  assert.equal(machineFor(job('x', 1, { tag_list: ['saas-linux-medium-amd64'] })).vcpus, 4);
});

test('report sums finished jobs only and states its boundary', () => {
  const report = buildReport([job('a', 60), job('b', 120), { name: 'running', duration: null, finished_at: null }], { env: {} });
  assert.equal(report.jobsMeasured, 2);
  assert.equal(report.runnerSeconds, 180);
  assert.ok(Math.abs(report.sciGramsPerPipeline - (report.operationalGrams + report.embodiedGrams)) < 1e-12);
  assert.match(report.boundary.excluded, /LLM inference/);
  assert.match(report.coefficients.embodiedKgPerHost.source, /assumption/);
});

test('coefficients can be overridden', () => {
  const report = buildReport([job('a', 3600)], { env: { CARBON_GRID_G_PER_KWH: '0' , CARBON_EMBODIED_KG_PER_HOST: '0' } });
  assert.equal(report.sciGramsPerPipeline, 0);
});
