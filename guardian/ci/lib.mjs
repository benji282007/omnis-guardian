// Shared helpers for CI scripts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readPackage(root = process.cwd()) {
  return JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
}

/** Parse "Name <email>" (the CI_COMMIT_AUTHOR format). */
export function parseAuthor(value = '') {
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  return match ? { name: match[1].trim(), email: match[2].trim().toLowerCase() } : { name: value.trim(), email: '' };
}
