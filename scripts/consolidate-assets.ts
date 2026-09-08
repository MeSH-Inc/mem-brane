import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { FileAssetStore } from '../server/storage/assets.js';
import {
  planLegacyConsolidation,
  consolidateLegacyAssets,
  cleanupConsolidatedAssets,
} from '../server/storage/legacy-consolidation.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    offline: { type: 'boolean' },
    database: { type: 'string' },
    assets: { type: 'string' },
    backup: { type: 'string' },
  },
});
const mode = positionals[0];
if (
  !values.offline ||
  !values.database ||
  !values.assets ||
  !['plan', 'apply', 'cleanup'].includes(mode) ||
  (mode !== 'plan' && !values.backup)
)
  throw new Error(
    'Stop the server and settle object writes, then use: plan|apply|cleanup --offline --database PATH --assets DIRECTORY [--backup DIRECTORY]',
  );
const db = new Database(values.database, { fileMustExist: true, readonly: mode === 'plan' });
db.pragma('foreign_keys=ON');
db.pragma('busy_timeout=5000');
try {
  const store = new FileAssetStore(values.assets);
  const result =
    mode === 'plan'
      ? await planLegacyConsolidation(db, store)
      : mode === 'apply'
        ? await consolidateLegacyAssets(db, store, values.backup!)
        : await cleanupConsolidatedAssets(db, store, values.backup!);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  db.close();
}
