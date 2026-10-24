import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatement, parseDigestRef } from '../ci/provenance.mjs';
import { verifyProvenance } from '../ci/verify-provenance.mjs';
import { evaluateReleaseGate } from '../ci/release-gate.mjs';
import { parseAuthor } from '../ci/lib.mjs';

const COMMIT = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const IMAGE = `registry.gitlab.example/group/omnis/kutt@sha256:${DIGEST}`;
const BASE = `docker.io/library/node@sha256:${'b'.repeat(64)}`;
const CI_ENV = {
  CI: 'true',
  CI_SERVER_URL: 'https://gitlab.example',
  CI_PROJECT_URL: 'https://gitlab.example/group/omnis',
  CI_PROJECT_PATH: 'group/omnis',
  CI_COMMIT_REF_NAME: 'main',
  CI_RUNNER_ID: '42',
  CI_JOB_URL: 'https://gitlab.example/group/omnis/-/jobs/1',
  CI_PIPELINE_URL: 'https://gitlab.example/group/omnis/-/pipelines/1'
};

function dist(imageInfo, statementInfo = imageInfo) {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  writeFileSync(join(dir, 'image.json'), JSON.stringify(imageInfo));
  writeFileSync(join(dir, 'provenance.intoto.json'), JSON.stringify(buildStatement({ imageInfo: statementInfo, env: CI_ENV })));
  return dir;
}

test('parseDigestRef only accepts digest-pinned references', () => {
  assert.deepEqual(parseDigestRef(IMAGE), { name: 'registry.gitlab.example/group/omnis/kutt', sha256: DIGEST });
  assert.throws(() => parseDigestRef('registry.gitlab.example/group/omnis/kutt:latest'));
});

test('statement binds the image digest, source commit and base image', () => {
  const stmt = buildStatement({ imageInfo: { imageRef: IMAGE, baseImageRef: BASE, commit: COMMIT }, env: CI_ENV });
  assert.equal(stmt._type, 'https://in-toto.io/Statement/v1');
  assert.deepEqual(stmt.subject, [{ name: 'registry.gitlab.example/group/omnis/kutt', digest: { sha256: DIGEST } }]);
  const deps = stmt.predicate.buildDefinition.resolvedDependencies;
  assert.deepEqual(deps[0].digest, { gitCommit: COMMIT });
  assert.equal(deps[1].uri, 'docker://docker.io/library/node');
  assert.equal(stmt.predicate.runDetails.builder.id, 'https://gitlab.example/group/omnis/-/runners/42');
  assert.match(stmt.predicate.buildDefinition.buildType, /\/-\/blob\/c{40}\/docs\/PROVENANCE\.md/);
});

test('verification passes for a matching image, commit and statement', () => {
  const info = { imageRef: IMAGE, baseImageRef: BASE, commit: COMMIT };
  const result = verifyProvenance({ distDir: dist(info), expectCommit: COMMIT });
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
});

test('verification fails when the pushed image differs from the attested one', () => {
  const attested = { imageRef: IMAGE, commit: COMMIT };
  const pushed = { imageRef: IMAGE.replace(DIGEST, 'e'.repeat(64)), commit: COMMIT };
  const result = verifyProvenance({ distDir: dist(pushed, attested), expectCommit: COMMIT });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((c) => !c.ok && /pushed image digest/.test(c.name)));
});

test('verification fails for a different commit or a tag-only reference', () => {
  const info = { imageRef: IMAGE, commit: COMMIT };
  assert.equal(verifyProvenance({ distDir: dist(info), expectCommit: 'f'.repeat(40) }).ok, false);
  const dir = dist(info);
  writeFileSync(join(dir, 'image.json'), JSON.stringify({ imageRef: 'registry/kutt:latest', commit: COMMIT }));
  assert.equal(verifyProvenance({ distDir: dir, expectCommit: COMMIT }).ok, false);
});

const baseEnv = {
  CI_COMMIT_BRANCH: 'main',
  CI_DEFAULT_BRANCH: 'main',
  CI_JOB_MANUAL: 'true',
  CI_COMMIT_SHA: COMMIT,
  CI_COMMIT_AUTHOR: 'Dev Person <dev@example.test>',
  GITLAB_USER_LOGIN: 'reviewer',
  GITLAB_USER_EMAIL: 'reviewer@example.test',
  RELEASE_APPROVERS: 'reviewer, lead'
};
const good = { security: { passed: true, commit: COMMIT }, provenance: { ok: true, checks: [] }, signature: { verified: true } };

test('gate approves when every check holds', () => {
  const r = evaluateReleaseGate({ env: baseEnv, ...good });
  assert.equal(r.approved, true, JSON.stringify(r.checks, null, 2));
  assert.equal(r.approver, 'reviewer');
});

test('gate blocks approvers who are not on the allow-list', () => {
  assert.equal(evaluateReleaseGate({ env: { ...baseEnv, GITLAB_USER_LOGIN: 'mallory' }, ...good }).approved, false);
  assert.equal(evaluateReleaseGate({ env: { ...baseEnv, RELEASE_APPROVERS: '' }, ...good }).approved, false);
});

test('gate enforces four-eyes unless explicitly disabled', () => {
  const selfApprove = { ...baseEnv, GITLAB_USER_EMAIL: 'DEV@example.test', RELEASE_APPROVERS: 'reviewer' };
  assert.equal(evaluateReleaseGate({ env: selfApprove, ...good }).approved, false);
  const solo = evaluateReleaseGate({ env: { ...selfApprove, RELEASE_REQUIRE_FOUR_EYES: 'false' }, ...good });
  assert.equal(solo.approved, true);
  assert.equal(solo.fourEyesEnforced, false);
});

test('gate blocks non-default branches, automatic runs, failed security and bad provenance', () => {
  assert.equal(evaluateReleaseGate({ env: { ...baseEnv, CI_COMMIT_BRANCH: 'feature' }, ...good }).approved, false);
  assert.equal(evaluateReleaseGate({ env: { ...baseEnv, CI_JOB_MANUAL: undefined }, ...good }).approved, false);
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, security: { passed: false, commit: COMMIT } }).approved, false);
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, security: { passed: true, commit: 'b'.repeat(40) } }).approved, false);
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, security: null }).approved, false);
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, provenance: { ok: false, checks: [{ ok: false, name: 'x' }] } }).approved, false);
});

test('gate requires verified signatures by default', () => {
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, signature: null }).approved, false);
  assert.equal(evaluateReleaseGate({ env: baseEnv, ...good, signature: { verified: false } }).approved, false);
  const off = evaluateReleaseGate({ env: { ...baseEnv, RELEASE_REQUIRE_SIGNATURE: 'false' }, ...good, signature: null });
  assert.equal(off.approved, true);
  assert.equal(off.signature.required, false);
});

test('parseAuthor handles the CI_COMMIT_AUTHOR format', () => {
  assert.deepEqual(parseAuthor('Ada Lovelace <Ada@Example.test>'), { name: 'Ada Lovelace', email: 'ada@example.test' });
});
