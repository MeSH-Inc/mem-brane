import Database from 'better-sqlite3';
import { config } from '../server/app/config.js';
import { assetStore } from '../server/storage/assets.js';
if (!process.argv.includes('--offline'))
  throw new Error(
    'Stop the server and wait for outstanding object writes to settle, then pass --offline.',
  );
const db = new Database(config.DATABASE_PATH, { fileMustExist: true });
const store = assetStore();
try {
  for (const row of db.prepare('SELECT id FROM upload_intents').all() as { id: string }[]) {
    if (db.prepare('SELECT 1 FROM assets WHERE storage_key=?').get(row.id))
      throw new Error('Upload intent overlaps committed asset');
    try {
      await store.delete(row.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    db.prepare('DELETE FROM upload_intents WHERE id=?').run(row.id);
    console.log(`Reconciled upload ${row.id}`);
  }
} finally {
  db.close();
}
