// Fixture: real `npm audit --omit=dev --json` output for upstream Kutt v3.2.6,
// captured on 2026-10-24 before Omnis Guardian upgraded its dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toGitLabReport } from '../ci/dependency-report.mjs';
import { evaluateReports } from '../ci/security-gate.mjs';

const upstream = JSON.parse(readFileSync(new URL('./fixtures/npm-audit-upstream-kutt-3.2.6.json', import.meta.url), 'utf8'));

test('converts npm audit output to a GitLab dependency report', () => {
  const report = toGitLabReport(upstream);
  assert.equal(report.scan.type, 'dependency_scanning');
  assert.equal(report.scan.status, 'success');
  assert.equal(report.vulnerabilities.length, 12);
  const severities = report.vulnerabilities.map((v) => v.severity);
  assert.equal(severities.filter((s) => s === 'Critical').length, 3);
  assert.equal(severities.filter((s) => s === 'High').length, 5);
  const hb = report.vulnerabilities.find((v) => v.id === 'npm-handlebars');
  assert.ok(hb.identifiers.every((i) => i.type === 'ghsa' && i.url.startsWith('https://github.com/advisories/')));
});

test('the security gate blocks upstream Kutt on its dependencies', () => {
  const result = evaluateReports([{ path: 'gl-dependency-report.json', report: toGitLabReport(upstream) }]);
  assert.equal(result.passed, false);
  assert.equal(result.counts.Critical, 3);
  assert.equal(result.counts.High, 5);
});

test('a clean audit passes and moderate findings do not block', () => {
  const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
  assert.equal(evaluateReports([{ path: 'x', report: toGitLabReport(clean) }]).passed, true);
  const moderate = { vulnerabilities: { uuid: { name: 'uuid', severity: 'moderate', range: '<11', via: [{ source: 1, title: 't', url: 'https://github.com/advisories/GHSA-x' }], fixAvailable: false } } };
  assert.equal(evaluateReports([{ path: 'x', report: toGitLabReport(moderate) }]).passed, true);
});

test('a failed audit fails closed', () => {
  const report = toGitLabReport({ error: { summary: 'network' } });
  assert.equal(report.scan.status, 'failure');
  assert.equal(evaluateReports([{ path: 'x', report }]).passed, false);
});
