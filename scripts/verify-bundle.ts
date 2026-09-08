import { verifyBundle } from '../server/storage/bundle.js';
if (!process.argv[2])
  throw new Error('Usage: node --import tsx scripts/verify-bundle.ts /downloaded/backup-directory');
console.log(JSON.stringify(await verifyBundle(process.argv[2])));
