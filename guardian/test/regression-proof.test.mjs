import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This test uses a tiny fixture app laid out as app/src + app/test, so point the
// script at that layout before loading it.
process.env.GUARDIAN_SOURCE_PREFIXES = 'app/src/';
process.env.GUARDIAN_TEST_REGEX = '^app/test/.+\\.test\\.js$';
const { proveRegression, decide, summariseTap } = await import('../ci/regression-proof.mjs');
const FIXTURE = new URL('./fixtures/mini-app/', import.meta.url).pathname;

const VULNERABLE_SEARCH = `
export function searchActiveUsers(db, prefix) {
  return db
    .prepare(\`SELECT id, username FROM users WHERE username LIKE '\${prefix}%' AND active = 1 ORDER BY username\`)
    .all()
    .map((row) => ({ ...row }));
}
`;

const FIXED_SEARCH = `
export function searchActiveUsers(db, prefix) {
  if (typeof prefix !== 'string' || prefix.length > 32) return [];
  const escaped = prefix.replace(/[\\\\%_]/g, (c) => '\\\\' + c);
  return db
    .prepare("SELECT id, username FROM users WHERE username LIKE ? ESCAPE '\\\\' AND active = 1 ORDER BY username")
    .all(escaped + '%')
    .map((row) => ({ ...row }));
}
`;

const GOOD_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { searchActiveUsers } from '../src/users.js';

test('search treats injection payloads as literal text', () => {
  const db = openDatabase();
  assert.deepEqual(searchActiveUsers(db, "zz' OR '1'='1' --"), []);
});

test('search still finds active users by prefix', () => {
  assert.deepEqual(searchActiveUsers(openDatabase(), 'gr').map((u) => u.username), ['grace']);
});
`;

const TRIVIAL_TEST = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { searchActiveUsers } from '../src/users.js';
test('search finds grace', () => {
  assert.deepEqual(searchActiveUsers(openDatabase(), 'gr').map((u) => u.username), ['grace']);
});
`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-repo-'));
  cpSync(join(FIXTURE, 'src'), join(dir, 'app/src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'app/test'), { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.test');
  g('config', 'user.name', 'test');
  const usersPath = join(dir, 'app/src/users.js');
  const original = readFileSync(usersPath, 'utf8');
  writeFileSync(usersPath, original + VULNERABLE_SEARCH);
  g('add', '-A');
  g('commit', '-qm', 'feature: user search (vulnerable)');
  const base = g('rev-parse', 'HEAD');
  const commitVariant = (branch, testBody) => {
    g('checkout', '-q', '-b', branch, base);
    writeFileSync(usersPath, original + FIXED_SEARCH);
    if (testBody) {
      mkdirSync(join(dir, 'app/test'), { recursive: true });
      writeFileSync(join(dir, 'app/test/user-search.test.js'), testBody);
    }
    g('add', '-A');
    g('commit', '-qm', `fix: ${branch}`);
    return g('rev-parse', 'HEAD');
  };
  return {
    dir,
    base,
    good: commitVariant('good', GOOD_TEST),
    trivial: commitVariant('trivial', TRIVIAL_TEST),
    noTest: commitVariant('no-test', null)
  };
}

const repo = makeRepo();

test('a fix whose test fails on the vulnerable code is PROVEN', () => {
  execFileSync('git', ['checkout', '-q', repo.good], { cwd: repo.dir });
  const result = proveRegression({ repo: repo.dir, base: repo.base, head: repo.good, requireTest: true });
  assert.equal(result.verdict, 'proven', result.reason + '\n' + result.logs.base);
  assert.equal(result.headRun.exitCode, 0);
  assert.ok(result.baseRun.assertionFailures >= 1);
});

test('a test that also passes on the vulnerable code does not count', () => {
  execFileSync('git', ['checkout', '-q', repo.trivial], { cwd: repo.dir });
  const result = proveRegression({ repo: repo.dir, base: repo.base, head: repo.trivial, requireTest: true });
  assert.equal(result.verdict, 'failed');
  assert.match(result.reason, /also pass on the old code/);
});

test('a source fix without a test fails when tests are required', () => {
  execFileSync('git', ['checkout', '-q', repo.noTest], { cwd: repo.dir });
  const result = proveRegression({ repo: repo.dir, base: repo.base, head: repo.noTest, requireTest: true });
  assert.equal(result.verdict, 'failed');
  assert.match(result.reason, /without a new or updated regression test/);
});

test('decide() treats load errors on the old code as inconclusive', () => {
  const verdict = decide({
    sourceChanged: true,
    testFiles: ['app/test/x.test.js'],
    requireTest: true,
    head: { exitCode: 0, ok: 2, notOk: 0 },
    base: { exitCode: 1, assertionFailures: 0, loadErrors: 1 }
  });
  assert.equal(verdict.verdict, 'inconclusive');
  assert.equal(verdict.proven, false);
});

test('summariseTap counts outcomes', () => {
  const tap = "ok 1 - a\nnot ok 2 - b\n  failureType: 'testCodeFailure'\n";
  assert.deepEqual(summariseTap(tap), { ok: 1, notOk: 1, assertionFailures: 1, loadErrors: 0 });
});

test('outside fix branches the check is informational and never blocks', () => {
  const head = { exitCode: 0, ok: 1, notOk: 0 };
  const base = { exitCode: 0, assertionFailures: 0, loadErrors: 0 };
  const v = decide({ sourceChanged: true, testFiles: ['app/test/x.test.js'], requireTest: false, head, base });
  assert.equal(v.proven, true);
  assert.equal(v.verdict, 'informational');
  assert.match(v.reason, /also pass on the old code/);
  const strict = decide({ sourceChanged: true, testFiles: ['app/test/x.test.js'], requireTest: true, head, base });
  assert.equal(strict.verdict, 'failed');
  assert.equal(strict.enforced, true);
});
