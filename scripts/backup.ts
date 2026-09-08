import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../server/app/config.js';
const destination = process.argv[2];
if (!destination)
  throw new Error('Usage: node --import tsx scripts/backup.ts /backup/new-file.sqlite');
if (resolve(destination) === resolve(config.DATABASE_PATH) || existsSync(destination))
  throw new Error('Choose a new backup file; existing files are not overwritten');
mkdirSync(dirname(destination), { recursive: true });
const source = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: true });
try {
  await source.backup(destination);
} finally {
  source.close();
}
const backup = new Database(destination, { readonly: true });
try {
  if (backup.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('Backup integrity check failed');
} finally {
  backup.close();
}
console.log(`Verified SQLite backup: ${destination}`);
