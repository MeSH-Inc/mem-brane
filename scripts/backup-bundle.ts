import { config } from '../server/app/config.js';
import { assetStore } from '../server/storage/assets.js';
import { createBundle } from '../server/storage/bundle.js';
const destination = process.argv[2];
if (!destination)
  throw new Error('Usage: node --import tsx scripts/backup-bundle.ts /new/backup-directory');
console.log(
  JSON.stringify(await createBundle(config.DATABASE_PATH, assetStore(), destination), null, 2),
);
