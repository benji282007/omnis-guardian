#!/usr/bin/env node
// Dependency scan: run `npm audit` on production dependencies and convert the
// result to a GitLab security report (scan type dependency_scanning) that the
// security gate understands. If npm audit cannot produce a result (for example
// the registry is unreachable), the report says so and the gate fails closed.
//
// Usage: node guardian/ci/dependency-report.mjs [--out gl-dependency-report.json] [--audit-json file]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEVERITY = { critical: 'Critical', high: 'High', moderate: 'Medium', low: 'Low', info: 'Info' };

/** Convert `npm audit --json` output (npm 7+) into a GitLab security report. */
export function toGitLabReport(audit, { now = new Date() } = {}) {
  const time = now.toISOString().replace(/\.\d+Z$/, '');
  const scan = {
    type: 'dependency_scanning',
    status: 'success',
    start_time: time,
    end_time: time,
    analyzer: { id: 'omnis-npm-audit', name: 'npm audit (Omnis Guardian)', version: '1.0.0', vendor: { name: 'Omnis Guardian' } },
    scanner: { id: 'npm-audit', name: 'npm audit', version: '1.0.0', vendor: { name: 'npm' } }
  };
  if (!audit || typeof audit.vulnerabilities !== 'object' || audit.error) {
    return { version: '15.0.4', vulnerabilities: [], scan: { ...scan, status: 'failure' }, error: audit?.error?.summary ?? 'npm audit produced no result' };
  }

  const vulnerabilities = Object.values(audit.vulnerabilities).map((pkg) => {
    const advisories = pkg.via.filter((v) => typeof v === 'object');
    const viaPackages = pkg.via.filter((v) => typeof v === 'string');
    const title = advisories[0]?.title ?? `vulnerable through ${viaPackages.join(', ')}`;
    const fix = pkg.fixAvailable === true ? 'fix available' : pkg.fixAvailable ? `fix: ${pkg.fixAvailable.name}@${pkg.fixAvailable.version}${pkg.fixAvailable.isSemVerMajor ? ' (major)' : ''}` : 'no fix available';
    return {
      id: `npm-${pkg.name}`,
      category: 'dependency_scanning',
      name: `${pkg.name}: ${title}`,
      message: `${pkg.name} ${pkg.range} — ${advisories.length} advisory(ies); ${fix}`,
      severity: SEVERITY[pkg.severity] ?? 'Unknown',
      solution: fix,
      location: { file: 'package-lock.json', dependency: { package: { name: pkg.name }, version: pkg.range } },
      identifiers: advisories.length
        ? advisories.map((a) => ({ type: 'ghsa', name: a.url?.split('/').pop() ?? String(a.source), value: String(a.source), url: a.url }))
        : [{ type: 'npm', name: `via ${viaPackages.join(', ')}`, value: pkg.name }]
    };
  });
  return { version: '15.0.4', vulnerabilities, scan };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  let audit = null;
  const input = arg('--audit-json');
  if (input) {
    audit = JSON.parse(readFileSync(input, 'utf8'));
  } else {
    // npm audit exits non-zero when it finds vulnerabilities; that is not an error here.
    const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try {
      audit = JSON.parse(run.stdout);
    } catch {
      audit = { error: { summary: `npm audit failed: ${(run.stderr || '').slice(0, 300)}` } };
    }
  }
  const report = toGitLabReport(audit);
  writeFileSync(arg('--out', 'gl-dependency-report.json'), JSON.stringify(report, null, 2) + '\n');
  const counts = report.vulnerabilities.reduce((acc, v) => ({ ...acc, [v.severity]: (acc[v.severity] ?? 0) + 1 }), {});
  console.log(`npm audit: ${report.scan.status}; ${report.vulnerabilities.length} vulnerable package(s) ${JSON.stringify(counts)}`);
  for (const v of report.vulnerabilities) console.log(`  [${v.severity}] ${v.message}`);
}
