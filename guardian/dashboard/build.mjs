#!/usr/bin/env node
// Assemble the GitLab Pages evidence dashboard: static UI + config.json +
// evidence.json. evidence.json is built only from artifacts of the current
// pipeline; anything missing is listed under "missing" and shown as missing.
//
// Usage: node guardian/dashboard/build.mjs [--out public]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyProvenance } from '../ci/verify-provenance.mjs';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'public';
const env = process.env;
const here = new URL('.', import.meta.url).pathname;

mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.js', 'model.js', 'favicon.svg']) cpSync(join(here, f), join(out, f));

const missing = [];
const read = (p) => {
  if (!existsSync(p)) {
    missing.push(p);
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf8'));
};

const security = read('security-summary.json');
const smoke = read('smoke-result.json');
const image = read('dist/image.json');
const signature = read('dist/signature-result.json');
const carbon = read('carbon-report.json');
let provenance = null;
if (existsSync('dist/provenance.intoto.json')) {
  const stmt = JSON.parse(readFileSync('dist/provenance.intoto.json', 'utf8'));
  const check = verifyProvenance({ distDir: 'dist', expectCommit: env.CI_COMMIT_SHA });
  provenance = {
    verified: check.ok,
    failedChecks: check.checks.filter((c) => !c.ok).map((c) => c.name),
    subject: stmt.subject?.[0] ?? null,
    commit: stmt.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit ?? null,
    baseImage: stmt.predicate?.buildDefinition?.resolvedDependencies?.[1] ?? null,
    builder: stmt.predicate?.runDetails?.builder?.id ?? null,
    invocation: stmt.predicate?.runDetails?.metadata?.invocationId ?? null,
    predicateType: stmt.predicateType,
    statementUrl: env.CI_PROJECT_URL && env.BUILD_JOB_ID ? `${env.CI_PROJECT_URL}/-/jobs/${env.BUILD_JOB_ID}/artifacts/raw/dist/provenance.intoto.json` : null
  };
} else {
  missing.push('dist/provenance.intoto.json');
}

const config = {
  projectId: env.CI_PROJECT_ID ?? null,
  projectPath: env.CI_PROJECT_PATH ?? null,
  projectUrl: env.CI_PROJECT_URL ?? null,
  apiUrl: env.CI_API_V4_URL ?? null,
  defaultBranch: env.CI_DEFAULT_BRANCH ?? 'main',
  // Exact username of the Duo flow's service account, used to attribute incidents (no prefix match).
  guardianAccount: env.GUARDIAN_ACCOUNT ?? 'ai-omnis-guardian-omnis-guardian',
  upstream: 'https://github.com/thedevs-network/kutt'
};

const evidence = {
  pipeline: env.CI_PIPELINE_ID
    ? { id: Number(env.CI_PIPELINE_ID), iid: Number(env.CI_PIPELINE_IID), url: env.CI_PIPELINE_URL, sha: env.CI_COMMIT_SHA, ref: env.CI_COMMIT_REF_NAME }
    : null,
  security: security && { passed: security.passed, counts: security.counts, problems: security.problems, findings: security.findings.slice(0, 60) },
  smoke,
  image,
  provenance,
  signature,
  carbon: carbon && {
    sciGramsPerPipeline: carbon.sciGramsPerPipeline,
    energyKwh: carbon.energyKwh,
    operationalGrams: carbon.operationalGrams,
    embodiedGrams: carbon.embodiedGrams,
    runnerSeconds: carbon.runnerSeconds,
    jobsMeasured: carbon.jobsMeasured,
    boundary: carbon.boundary,
    gridGramsPerKwh: carbon.coefficients?.gridGramsPerKwh?.value ?? null
  },
  missing,
  builtAt: new Date().toISOString()
};

writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`Dashboard written to ${out}/ (missing evidence: ${missing.length ? missing.join(', ') : 'none'})`);
