// User lookups. Every query uses bound parameters; never build SQL from input.

const USERNAME_PATTERN = /^[a-z0-9_.-]{1,32}$/i;

export function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

/**
 * Find an active user by exact username.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 */
export function findActiveUser(db, username) {
  if (!isValidUsername(username)) return null;
  const row = db
    .prepare('SELECT id, username, email, role FROM users WHERE username = ? AND active = 1')
    .get(username);
  // node:sqlite returns null-prototype rows; hand callers a plain object.
  return row ? { ...row } : null;
}
