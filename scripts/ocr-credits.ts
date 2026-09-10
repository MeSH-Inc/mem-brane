import { parseArgs } from 'node:util';
import { openDatabase } from '../server/db/index';
import { config } from '../server/app/config';
import { grantOcrCredits, ocrCredits } from '../server/services/ocr';
const { values } = parseArgs({
  options: {
    actor: { type: 'string' },
    receipt: { type: 'string' },
    kind: { type: 'string' },
    pages: { type: 'string' },
    evidence: { type: 'string' },
  },
});
if (!values.actor)
  throw new Error(
    'Usage: --actor USER_ID [--receipt UNIQUE_ID --kind trial|prepaid --pages INTEGER --evidence "verified payment or invitation reference"]',
  );
const db = openDatabase(config.DATABASE_PATH);
try {
  if (values.receipt) {
    if (values.kind !== 'trial' && values.kind !== 'prepaid')
      throw new Error('Choose trial or prepaid');
    grantOcrCredits(db, {
      id: values.receipt,
      actor: values.actor,
      kind: values.kind,
      pages: Number(values.pages),
      evidence: values.evidence ?? '',
    });
  } else if (values.kind || values.pages || values.evidence)
    throw new Error('A unique receipt is required to grant credits');
  console.log(ocrCredits(db, values.actor));
} finally {
  db.close();
}
