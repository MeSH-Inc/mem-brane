// Disposable stress probe for read boundaries, independent of run-admission limits.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../server/db/index.js';
import {
  createBrane,
  createBlock,
  readBrane,
  readRevision,
  readRevisionPage,
  revisions,
  uid,
} from '../server/services/content.js';
import { lineageInputs } from '../server/services/contexts.js';
import { inspectPdf } from '../server/ingestion/pdf.js';
import { pdfFixture } from '../tests/fixtures/pdf.js';
import { buildMessages } from '../server/llm/model.js';
import { verifyRestoration } from '../server/storage/verify.js';
import type { PdfContent } from '../shared/types/domain.js';
const db = openDatabase(':memory:');
try {
  const actor = uid(),
    asset = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Fixture',
    `${actor}@test`,
    0,
    0,
  );
  const brane = createBrane(db, actor).id;
  const bytes = pdfFixture(
    Array.from({ length: 4 }, () =>
      Array.from({ length: 30 }, () => 'Immutable evidence '.repeat(3)).join('\n'),
    ),
  );
  const hash = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'application/pdf',
    bytes.length,
    0,
    hash,
  );
  const content: PdfContent = {
    format: 'pdf',
    text: 'Evidence',
    filename: 'Evidence.pdf',
    assetId: asset,
    assetHash: hash,
    mimeType: 'application/pdf',
    ...(await inspectPdf(bytes)),
  };
  if (content.representation.status !== 'ready') throw new Error('Fixture extraction failed');
  const blocks = Array.from({ length: 200 }, (_, i) =>
    createBlock(db, actor, 'pdf', { ...content, text: `Artifact ${i}` }, brane),
  );
  const frozen = blocks.map((b) => revisions(db).snapshotBlock(actor, b.id));
  const measure = <T>(work: () => T) => {
    const prepare = db.prepare.bind(db),
      queries: string[] = [];
    db.prepare = ((sql: string) => {
      queries.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      return {
        value: work(),
        statements: queries.length,
        representationQueries: queries.filter((q) => q.includes('FROM asset_representations'))
          .length,
      };
    } finally {
      db.prepare = prepare;
    }
  };
  const workspace = measure(() => readBrane(db, actor, brane));
  const message: any = {
    id: uid(),
    role: 'user',
    revision_id: uid(),
    content: { format: 'text', text: 'Prompt' },
    references: frozen.map((r) => ({ label: 'Evidence', revision_id: r.id })),
  };
  const context = measure(() => lineageInputs(db, actor, [message]));
  const expected = [
    ...frozen.map((r, position) => ({
      position,
      kind: 'lineage_reference' as const,
      role: 'user' as const,
      label: 'Evidence',
      revision_id: r.id,
      content: r.content,
    })),
    {
      position: 200,
      kind: 'lineage' as const,
      role: 'user' as const,
      label: 'Conversation',
      revision_id: message.revision_id,
      content: message.content,
    },
  ];
  if (JSON.stringify(buildMessages(context.value)) !== JSON.stringify(buildMessages(expected)))
    throw new Error('Provider messages changed');
  for (let version = 1; version <= 100; version++) {
    db.prepare(
      "UPDATE block_live_state SET content_json=json_set(content_json,'$.text',?),version=version+1 WHERE block_id=?",
    ).run(`Snapshot ${version}`, blocks[0].id);
    revisions(db).snapshotBlock(actor, blocks[0].id);
  }
  const history = measure(() => readRevisionPage(db, actor, blocks[0].id));
  const expanded = {
    ...history.value,
    items: history.value.items.map((r) => readRevision(db, actor, r.id)),
  };
  const result = {
    method:
      '200-artifact shared-PDF read stress probe; inherited-reference expansion is measured separately from run admission. Byte figures are UTF-8 JSON, not heap measurements.',
    workspace: {
      artifacts: workspace.value.blocks.length,
      statements: workspace.statements,
      representationQueries: workspace.representationQueries,
      bytes: Buffer.byteLength(JSON.stringify(workspace.value)),
    },
    context: {
      references: 200,
      statements: context.statements,
      representationQueries: context.representationQueries,
      providerMessagesEqual: true,
    },
    history: {
      totalRevisions: 101,
      pageSize: history.value.items.length,
      statements: history.statements,
      representationQueries: history.representationQueries,
      summaryBytes: Buffer.byteLength(JSON.stringify(history.value)),
      expandedBytes: Buffer.byteLength(JSON.stringify(expanded)),
    },
    restore: await verifyRestoration(db, { get: async () => bytes }),
  };
  if (
    result.workspace.representationQueries !== 1 ||
    result.context.representationQueries !== 1 ||
    result.history.representationQueries !== 0 ||
    result.history.summaryBytes >= 10000
  )
    throw new Error('Read boundary regression');
  const json = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2]) await writeFile(process.argv[2], json);
  else process.stdout.write(json);
} finally {
  db.close();
}
