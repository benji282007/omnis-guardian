#!/usr/bin/env node
// Verify that the provenance statement describes exactly the image this
// pipeline built (digest) from exactly the commit being released. Signature
// checks against the registry are done separately with cosign
// (guardian/ci/verify-signatures.sh), whose result is read by the release gate.
//
// Usage: node guardian/ci/verify-provenance.mjs [--dist dist] [--expect-commit <sha>]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PREDICATE_TYPE, STATEMENT_TYPE, parseDigestRef } from './provenance.mjs';

export function verifyProvenance({ distDir, expectCommit }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const stmtPath = join(distDir, 'provenance.intoto.json');
  const infoPath = join(distDir, 'image.json');
  for (const p of [stmtPath, infoPath]) {
    if (!existsSync(p)) {
      check(`${p} present`, false, 'missing');
      return { ok: false, checks };
    }
  }
  const stmt = JSON.parse(readFileSync(stmtPath, 'utf8'));
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));

  check('statement type is in-toto v1', stmt._type === STATEMENT_TYPE, stmt._type);
  check('predicate type is SLSA provenance v1', stmt.predicateType === PREDICATE_TYPE, stmt.predicateType);
  const subjects = Array.isArray(stmt.subject) ? stmt.subject : [];
  check('exactly one subject', subjects.length === 1, `${subjects.length} subject(s)`);

  let image = null;
  try {
    image = parseDigestRef(info.imageRef);
  } catch (err) {
    check('image reference is pinned by digest', false, err.message);
  }
  if (image && subjects[0]) {
    check('subject digest matches the pushed image digest', subjects[0].digest?.sha256 === image.sha256, `image sha256:${image.sha256}`);
    check('subject name matches the image repository', subjects[0].name === image.name, subjects[0].name);
  }

  const commit = stmt.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
  check('source commit recorded as gitCommit', /^[0-9a-f]{40}$/.test(commit ?? ''), commit);
  check('image metadata and provenance agree on the commit', commit === info.commit, `image.json ${info.commit}`);
  if (expectCommit) check('source commit is the commit being released', commit === expectCommit, `expected ${expectCommit}`);

  return { ok: checks.every((c) => c.ok), checks, imageRef: info.imageRef ?? null, commit: commit ?? null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const result = verifyProvenance({ distDir: arg('--dist') ?? 'dist', expectCommit: arg('--expect-commit') ?? process.env.CI_COMMIT_SHA });
  for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(result.ok ? 'PROVENANCE VERIFIED' : 'PROVENANCE VERIFICATION FAILED');
  process.exitCode = result.ok ? 0 : 1;
}
