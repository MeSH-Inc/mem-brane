import Database from 'better-sqlite3';
import { FileAssetStore } from '../server/storage/assets.js';
import { verifyRestoration } from '../server/storage/verify.js';
const [database, assets] = process.argv.slice(2);
if (!database || !assets)
  throw new Error(
    'Usage: node --import tsx scripts/verify-restore.ts /restored/db.sqlite /restored/assets',
  );
const db = new Database(database, { readonly: true, fileMustExist: true });
try {
  console.log(JSON.stringify(await verifyRestoration(db, new FileAssetStore(assets))));
} finally {
  db.close();
}
