// Ledger API data layer. Uses Node's built-in SQLite driver (node:sqlite),
// so the service has zero third-party runtime dependencies.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email    TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    active   INTEGER NOT NULL DEFAULT 1
  );
`;

const SEED_USERS = [
  { username: 'ada', email: 'ada@example.test', role: 'admin', active: 1 },
  { username: 'grace', email: 'grace@example.test', role: 'member', active: 1 },
  { username: 'linus', email: 'linus@example.test', role: 'member', active: 0 }
];

/**
 * Open a database (in-memory by default) with the schema and demo seed data.
 * @param {string} [location]
 */
export function openDatabase(location = ':memory:') {
  const db = new DatabaseSync(location);
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const insert = db.prepare(
      'INSERT INTO users (username, email, role, active) VALUES (?, ?, ?, ?)'
    );
    for (const u of SEED_USERS) insert.run(u.username, u.email, u.role, u.active);
  }
  return db;
}
