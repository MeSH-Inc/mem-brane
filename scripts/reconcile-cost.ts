import { parseArgs } from 'node:util';
import { openDatabase } from '../server/db/index';
import { config } from '../server/app/config';
import { reconcileUncertainCost } from '../server/services/costs';
const { values } = parseArgs({
  options: { run: { type: 'string' }, microusd: { type: 'string' }, evidence: { type: 'string' } },
});
if (!values.run || values.microusd === undefined || !values.evidence)
  throw new Error('Usage: --run UUID --microusd INTEGER --evidence "provider billing reference"');
const db = openDatabase(config.DATABASE_PATH);
try {
  reconcileUncertainCost(db, values.run, Number(values.microusd), values.evidence);
  console.log('Uncertain billing reconciled with a permanent audit record.');
} finally {
  db.close();
}
