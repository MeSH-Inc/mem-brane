import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db/index';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const databasePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-brane-schema-'));
  dirs.push(dir);
  return join(dir, 'db.sqlite');
};

it('applies the baseline once and reopens without changes', () => {
  const path = databasePath();
  const db = openDatabase(path);
  expect(db.prepare('SELECT name FROM schema_migrations').pluck().all()).toEqual([
    '001-baseline.sql',
    '002-run-failure-reason.sql',
    '003-machines-and-feeds.sql',
    '004-card-backs.sql',
    '005-relations.sql',
    '006-groups.sql',
    '007-each-and-workshop.sql',
  ]);
  expect(db.prepare('SELECT enabled FROM guest_policy').pluck().get()).toBe(1);
  db.close();
  openDatabase(path).close();
});

it('refuses a database that predates the baseline', () => {
  const path = databasePath();
  const db = openDatabase(path);
  db.prepare('INSERT INTO schema_migrations VALUES (?)').run('029-card-library.sql');
  db.close();
  expect(() => openDatabase(path)).toThrow(/predates the schema baseline/);
});
