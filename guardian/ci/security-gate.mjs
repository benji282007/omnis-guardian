#!/usr/bin/env node
// Security gate: reads GitLab security report JSON files (SAST, secret detection)
// and fails the job when blocking findings exist. Fails closed: a missing,
// unreadable or unsuccessful report blocks the pipeline too.
//
// Usage: node guardian/ci/security-gate.mjs <report.json>... [--out security-summary.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BLOCKING = ['Critical', 'High'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info', 'Unknown'];

/**
 * @param {{ path: string, report: any | null, error?: string }[]} inputs
 * @param {string[]} blocking
 */
export function evaluateReports(inputs, blocking = DEFAULT_BLOCKING) {
  const problems = [];
  const findings = [];
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

  if (inputs.length === 0) problems.push('no security reports were provided');

  for (const { path, report, error } of inputs) {
    if (error || !report) {
      problems.push(`${path}: ${error ?? 'report missing'}`);
      continue;
    }
    if (!Array.isArray(report.vulnerabilities)) {
      problems.push(`${path}: not a GitLab security report (no vulnerabilities array)`);
      continue;
    }
    // Fail closed: GitLab security report schema v15 requires scan.status; anything but "success"
    // (including a missing status) means the scan cannot be trusted to have run.
    const status = report.scan?.status;
    if (status !== 'success') problems.push(`${path}: scan status is ${status ? `"${status}"` : 'missing'}`);

    for (const v of report.vulnerabilities) {
      const severity = SEVERITIES.includes(v.severity) ? v.severity : 'Unknown';
      counts[severity] += 1;
      findings.push({
        report: path,
        scanType: report.scan?.type ?? 'unknown',
        severity,
        name: v.name ?? v.message ?? 'unnamed finding',
        file: v.location?.file ?? null,
        line: v.location?.start_line ?? null,
        dependency: v.location?.dependency
          ? `${v.location.dependency.package?.name ?? '?'} ${v.location.dependency.version ?? ''}`.trim()
          : null,
        identifiers: (v.identifiers ?? []).map((i) => i.name).filter(Boolean),
        blocking: blocking.includes(severity)
      });
    }
  }

  const blockingFindings = findings.filter((f) => f.blocking);
  return {
    passed: problems.length === 0 && blockingFindings.length === 0,
    blockingSeverities: blocking,
    counts,
    problems,
    findings
  };
}

function loadReport(path) {
  if (!existsSync(path)) return { path, report: null, error: 'report file not found' };
  try {
    return { path, report: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { path, report: null, error: `unreadable report: ${err.message}` };
  }
}

function main(argv) {
  let out = 'security-summary.json';
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out = argv[++i];
    else paths.push(argv[i]);
  }
  const blocking = (process.env.SECURITY_GATE_BLOCKING ?? DEFAULT_BLOCKING.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const result = evaluateReports(paths.map(loadReport), blocking);
  const summary = {
    ...result,
    pipeline: process.env.CI_PIPELINE_URL ?? null,
    commit: process.env.CI_COMMIT_SHA ?? null,
    generatedAt: new Date().toISOString()
  };
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');

  console.log(`Security gate (blocking: ${blocking.join(', ')})`);
  console.log(SEVERITIES.map((s) => `${s}: ${result.counts[s]}`).join('  '));
  for (const f of result.findings) {
    const where = f.dependency ?? (f.file ? `${f.file}:${f.line ?? '?'}` : 'n/a');
    console.log(`${f.blocking ? 'BLOCK' : 'warn '} [${f.severity}] ${f.name} — ${where} (${f.scanType})`);
  }
  for (const p of result.problems) console.log(`BLOCK ${p}`);
  console.log(result.passed ? 'RESULT: PASSED' : 'RESULT: FAILED');
  return result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
