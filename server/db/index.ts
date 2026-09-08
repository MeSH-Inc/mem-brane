import { canonicalJson, representationId } from '../domain/canonical.js';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export type DB = Database.Database;
export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.function('canonical_json', { deterministic: true }, (json) =>
      canonicalJson(JSON.parse(String(json))),
    );
    db.function('representation_id', { deterministic: true }, (asset, format, payload) =>
      representationId(String(asset), String(format), String(payload)),
    );
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
    for (const name of readdirSync(resolve('migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) {
        // SQLite table rebuilds require enforcement off outside the transaction. Validate
        // the complete resulting graph before commit, then restore enforcement even on failure.
        db.pragma('foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(readFileSync(resolve('migrations', name), 'utf8'));
            if ((db.pragma('foreign_key_check') as unknown[]).length)
              throw new Error(`Migration ${name} violates foreign keys`);
            db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
          })();
        } finally {
          db.pragma('foreign_keys = ON');
        }
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
