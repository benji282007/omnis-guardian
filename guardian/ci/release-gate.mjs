#!/usr/bin/env node
// Supervised release gate. Runs inside the manual `release_gate` job, so the
// person who presses "Run" in GitLab *is* the approver (GitLab sets
// GITLAB_USER_LOGIN to the user who started a manual job). The gate re-checks
// the evidence instead of trusting earlier stages, then writes
// release-evidence.json. Any failed check blocks the release.
//
// Configuration (set as *protected* CI/CD variables in the project):
//   RELEASE_APPROVERS           comma-separated GitLab usernames allowed to approve (required)
//   RELEASE_REQUIRE_FOUR_EYES   "true" (default) blocks approvers who authored the commit
//   RELEASE_REQUIRE_SIGNATURE   "true" (default) blocks releases unless the image signature and
//                               provenance attestation verify (set "false" only to debug)
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAuthor, readJson } from './lib.mjs';
import { verifyProvenance } from './verify-provenance.mjs';

export function evaluateReleaseGate({ env, security, provenance, signature }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

  add('release runs on the default branch', env.CI_COMMIT_BRANCH && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH,
    `branch=${env.CI_COMMIT_BRANCH ?? 'none'} default=${env.CI_DEFAULT_BRANCH ?? 'none'}`);
  add('release was started manually by a person', env.CI_JOB_MANUAL === 'true', `CI_JOB_MANUAL=${env.CI_JOB_MANUAL ?? 'unset'}`);

  const approver = env.GITLAB_USER_LOGIN ?? '';
  const approvers = (env.RELEASE_APPROVERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  add('approver allow-list is configured', approvers.length > 0, approvers.length ? `${approvers.length} approver(s)` : 'RELEASE_APPROVERS is empty');
  add('approver is on the allow-list', approver && approvers.includes(approver.toLowerCase()), `approver=${approver || 'unknown'}`);

  const fourEyes = (env.RELEASE_REQUIRE_FOUR_EYES ?? 'true') !== 'false';
  const author = parseAuthor(env.CI_COMMIT_AUTHOR);
  const approverEmail = (env.GITLAB_USER_EMAIL ?? '').toLowerCase();
  if (fourEyes) {
    add('approver is not the commit author (four-eyes)', approverEmail && author.email && approverEmail !== author.email,
      `author=${author.email || 'unknown'}`);
  }

  add('security gate passed for this commit', security?.passed === true && security?.commit === env.CI_COMMIT_SHA,
    security ? `passed=${security.passed} commit=${(security.commit ?? '').slice(0, 12)}` : 'security-summary.json missing');
  add('provenance verified against the artifact', provenance?.ok === true,
    provenance ? provenance.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'all checks passed' : 'not run');

  const requireSignature = (env.RELEASE_REQUIRE_SIGNATURE ?? 'true') !== 'false';
  const signed = signature?.verified === true;
  if (requireSignature) add('artifact signature verified (Sigstore)', signed, signature ? signature.detail ?? '' : 'no signature result');

  return {
    approved: checks.every((c) => c.ok),
    approver: approver || null,
    fourEyesEnforced: fourEyes,
    signature: signature ? { verified: signed, required: requireSignature, detail: signature.detail ?? null } : { verified: false, required: requireSignature, detail: 'no signature produced' },
    checks
  };
}

function loadOptional(path) {
  return existsSync(path) ? readJson(path) : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const provenance = verifyProvenance({ distDir: 'dist', expectCommit: env.CI_COMMIT_SHA });
  const result = evaluateReleaseGate({
    env,
    security: loadOptional('security-summary.json'),
    provenance,
    signature: loadOptional('dist/signature-result.json')
  });
  const evidence = {
    ...result,
    commit: env.CI_COMMIT_SHA ?? null,
    pipeline: env.CI_PIPELINE_URL ?? null,
    job: env.CI_JOB_URL ?? null,
    image: provenance.imageRef,
    decidedAt: new Date().toISOString()
  };
  writeFileSync('release-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  if (!result.fourEyesEnforced) console.log('NOTE  four-eyes check disabled by RELEASE_REQUIRE_FOUR_EYES=false (recorded in evidence)');
  console.log(`Signature: ${result.signature.verified ? 'verified' : 'not verified'}${result.signature.required ? ' (required)' : ' (not required)'}`);
  console.log(result.approved ? `RELEASE APPROVED by ${result.approver}` : 'RELEASE BLOCKED');
  process.exitCode = result.approved ? 0 : 1;
}
