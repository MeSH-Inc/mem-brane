import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('adds version zero to existing placements without changing geometry', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(readFileSync('migrations/001-core.sql', 'utf8'));
    db.prepare('INSERT INTO placements VALUES (?,?,?,?,?,?,?,?,?)').run(
      'p',
      'b',
      'block',
      10,
      20,
      320,
      220,
      0,
      123,
    );
    db.exec(readFileSync('migrations/005-placement-version.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM placements WHERE id=?').get('p')).toMatchObject({
      x: 10,
      y: 20,
      width: 320,
      height: 220,
      version: 0,
      updated_at: 123,
    });
    expect(() => db.prepare('UPDATE placements SET version=-1 WHERE id=?').run('p')).toThrow();
  } finally {
    db.close();
  }
});
