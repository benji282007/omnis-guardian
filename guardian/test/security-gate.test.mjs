// Fixtures sast-*.json were produced by running Semgrep 1.182 with
// security/semgrep/rules.yml (see scripts/test/fixtures/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateReports } from '../ci/security-gate.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('passes a clean SAST report', () => {
  const result = evaluateReports([{ path: 'sast.json', report: fixture('sast-clean.json') }]);
  assert.equal(result.passed, true);
  assert.equal(result.findings.length, 0);
});

test('blocks the real Semgrep report for the vulnerable sample', () => {
  const result = evaluateReports([{ path: 'sast.json', report: fixture('sast-vulnerable.json') }]);
  assert.equal(result.passed, false);
  assert.equal(result.counts.High, 4);
  assert.ok(result.findings.every((f) => f.blocking));
  assert.ok(result.findings.some((f) => f.identifiers.some((id) => id.includes('og-sqli-dynamic-sql'))));
});

test('fails closed on missing, malformed or unsuccessful reports', () => {
  assert.equal(evaluateReports([]).passed, false);
  assert.equal(evaluateReports([{ path: 'x.json', report: null, error: 'report file not found' }]).passed, false);
  assert.equal(evaluateReports([{ path: 'x.json', report: { foo: 1 } }]).passed, false);
  const failedScan = { vulnerabilities: [], scan: { type: 'sast', status: 'failure' } };
  assert.equal(evaluateReports([{ path: 'x.json', report: failedScan }]).passed, false);
});

test('medium findings warn but do not block by default', () => {
  const report = {
    vulnerabilities: [{ severity: 'Medium', name: 'minor', location: { file: 'a.js', start_line: 1 } }],
    scan: { type: 'secret_detection', status: 'success' }
  };
  const result = evaluateReports([{ path: 'secrets.json', report }]);
  assert.equal(result.passed, true);
  assert.equal(result.counts.Medium, 1);
  assert.equal(evaluateReports([{ path: 'secrets.json', report }], ['Critical', 'High', 'Medium']).passed, false);
});

test('CLI exits non-zero and writes a summary for blocking findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const reportPath = join(dir, 'gl-sast-report.json');
  const outPath = join(dir, 'summary.json');
  writeFileSync(reportPath, JSON.stringify(fixture('sast-vulnerable.json')));
  const script = new URL('../ci/security-gate.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script, reportPath, '--out', outPath], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /RESULT: FAILED/);
  assert.equal(JSON.parse(readFileSync(outPath, 'utf8')).passed, false);
});
