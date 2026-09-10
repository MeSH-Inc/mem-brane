import { parseArgs } from 'node:util';
import { openDatabase } from '../server/db/index';
import { config } from '../server/app/config';
import { OcrService } from '../server/services/ocr';
import { assetStore } from '../server/storage/assets';
const { values } = parseArgs({
  options: { job: { type: 'string' }, pages: { type: 'string' }, evidence: { type: 'string' } },
});
if (!values.job || values.pages === undefined || !values.evidence)
  throw new Error(
    'Usage: --job UUID --pages CONFIRMED_BILLED_PAGES --evidence "provider billing reference"',
  );
const db = openDatabase(config.DATABASE_PATH);
try {
  new OcrService(db, assetStore()).reconcile(values.job, Number(values.pages), values.evidence);
  console.log('OCR billing reconciled; held page credits settled.');
} finally {
  db.close();
}
