import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export type DB = Database.Database;
export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  for (const name of readdirSync(resolve('migrations'))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name))
      db.transaction(() => {
        db.exec(readFileSync(resolve('migrations', name), 'utf8'));
        db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
      })();
  }
  return db;
}
