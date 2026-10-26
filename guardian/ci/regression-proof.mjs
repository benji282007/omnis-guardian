#!/usr/bin/env node
// Regression proof for remediation merge requests.
//
// A fix is only "verified" when the tests it adds or changes:
//   1. pass against the merge request's code (HEAD), and
//   2. fail with an assertion failure against the code it is fixing (BASE).
// That shows the test actually detects the defect instead of passing trivially.
//
// Usage: node guardian/ci/regression-proof.mjs [--base <sha>] [--head <sha>] [--require-test] [--out file]
// In merge request pipelines BASE defaults to CI_MERGE_REQUEST_DIFF_BASE_SHA.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Kutt layout: application code in server/, tests in test/ (helpers excluded).
const SOURCE_PREFIXES = (process.env.GUARDIAN_SOURCE_PREFIXES ?? 'server/').split(',').filter(Boolean);
const TEST_PATTERN = new RegExp(process.env.GUARDIAN_TEST_REGEX ?? '^test/(?!helpers/).+\\.test\\.js$');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Summarise `node --test` TAP output into pass / assertion-fail / load-error counts. */
export function summariseTap(output) {
  const notOk = (output.match(/^\s*not ok \d+/gm) ?? []).length;
  const ok = (output.match(/^\s*ok \d+/gm) ?? []).length;
  const assertionFailures = (output.match(/failureType: 'testCodeFailure'/g) ?? []).length;
  const loadErrors =
    (output.match(/failureType: '(testFileFailure|hookFailure|cancelledByParent)'/g) ?? []).length +
    (/(ERR_MODULE_NOT_FOUND|SyntaxError: )/.test(output) ? 1 : 0);
  return { ok, notOk, assertionFailures, loadErrors };
}

function runTests(cwd, files) {
  // A parent node:test runner sets NODE_TEST_CONTEXT; if inherited, the child
  // silently skips every file. Always run the child as a top-level runner.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=60000', '--test-reporter=tap', ...files],
    { cwd, env, encoding: 'utf8', timeout: 300_000 }
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { exitCode: res.status, ...summariseTap(output), output };
}

/** Pure decision logic, exported for tests. */
export function decide({ sourceChanged, testFiles, requireTest, head, base }) {
  // Strict (requireTest, i.e. guardian/* fix branches): the changed tests must prove the fix.
  // Otherwise (feature work): report what was found, but never fail the pipeline, because a
  // test for NEW behaviour is expected to fail or pass on the old code for unrelated reasons.
  const result = (() => {
    if (!sourceChanged) return { proven: true, verdict: 'skipped', reason: 'no application source changed' };
    if (testFiles.length === 0) {
      return { proven: false, verdict: 'failed', reason: 'source changed without a new or updated regression test' };
    }
    if (head.ok + head.notOk === 0) return { proven: false, verdict: 'failed', reason: 'no regression tests actually ran on the fix (HEAD)' };
    if (head.exitCode !== 0) return { proven: false, verdict: 'failed', reason: 'regression tests fail on the fix (HEAD)' };
    if (base.exitCode === 0) {
      return { proven: false, verdict: 'failed', reason: 'regression tests also pass on the old code, so they do not detect the defect' };
    }
    if (base.assertionFailures === 0) {
      return { proven: false, verdict: 'inconclusive', reason: 'tests failed on the old code only because they could not load, not because an assertion caught the defect' };
    }
    return { proven: true, verdict: 'proven', reason: `${base.assertionFailures} assertion(s) fail on the old code and all pass on the fix` };
  })();
  if (requireTest || result.proven) return { ...result, enforced: requireTest };
  // Not a fix branch: keep the finding visible but do not block.
  return { proven: true, verdict: 'informational', enforced: false, reason: `not enforced on this branch (only guardian/* fix branches): ${result.reason}` };
}

export function proveRegression({ repo, base, head = 'HEAD', requireTest = false }) {
  const headSha = git(['rev-parse', head], repo);
  const baseSha = git(['rev-parse', base], repo);
  const changed = git(['diff', '--name-only', '--diff-filter=AMR', baseSha, headSha], repo).split('\n').filter(Boolean);
  const sourceChanged = changed.some((f) => SOURCE_PREFIXES.some((p) => f.startsWith(p)));
  const testFiles = changed.filter((f) => TEST_PATTERN.test(f));

  let headRun = null;
  let baseRun = null;
  if (sourceChanged && testFiles.length > 0) {
    headRun = runTests(repo, testFiles);
    // Materialise BASE in a temp dir, then drop HEAD's versions of the tests into it.
    const dir = mkdtempSync(join(tmpdir(), 'regression-base-'));
    try {
      const archive = execFileSync('git', ['archive', '--format=tar', baseSha], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', dir], { input: archive });
      // Reuse the installed dependencies; the old code is only source files.
      if (existsSync(join(repo, 'node_modules')) && !existsSync(join(dir, 'node_modules'))) {
        symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
      }
      for (const file of testFiles) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), readFileSync(join(repo, file)));
      }
      baseRun = runTests(dir, testFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const decision = decide({ sourceChanged, testFiles, requireTest, head: headRun, base: baseRun });
  const strip = (r) => (r ? { exitCode: r.exitCode, ok: r.ok, notOk: r.notOk, assertionFailures: r.assertionFailures, loadErrors: r.loadErrors } : null);
  return {
    ...decision,
    base: baseSha,
    head: headSha,
    changedFiles: changed,
    testFiles,
    headRun: strip(headRun),
    baseRun: strip(baseRun),
    logs: { head: headRun?.output ?? '', base: baseRun?.output ?? '' }
  };
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = opt('--base') ?? process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  if (!base) {
    console.error('regression-proof: no base commit (pass --base or run in a merge request pipeline)');
    return 1;
  }
  const requireTest = argv.includes('--require-test') || process.env.REQUIRE_REGRESSION_TEST === 'true';
  const result = proveRegression({ repo: process.cwd(), base, head: opt('--head') ?? 'HEAD', requireTest });
  const { logs, ...summary } = result;
  writeFileSync(opt('--out') ?? 'regression-proof.json', JSON.stringify({ ...summary, pipeline: process.env.CI_PIPELINE_URL ?? null, generatedAt: new Date().toISOString() }, null, 2) + '\n');

  console.log(`Base ${summary.base.slice(0, 12)} → head ${summary.head.slice(0, 12)}`);
  console.log(`Regression tests: ${summary.testFiles.join(', ') || '(none)'}`);
  if (summary.headRun) console.log(`On fix:      exit ${summary.headRun.exitCode}, ${summary.headRun.ok} passed, ${summary.headRun.notOk} failed`);
  if (summary.baseRun) console.log(`On old code: exit ${summary.baseRun.exitCode}, ${summary.baseRun.assertionFailures} assertion failure(s), ${summary.baseRun.loadErrors} load error(s)`);
  console.log(`VERDICT: ${summary.verdict.toUpperCase()} — ${summary.reason}`);
  if (!summary.proven && logs.base) console.log('\n--- test output on old code ---\n' + logs.base.slice(-4000));
  return summary.proven ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
