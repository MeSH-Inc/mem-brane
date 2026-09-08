import Database from 'better-sqlite3';
import type { DB } from '../../server/db/index.js';
import {
  createBlock,
  readBrane,
  readRevisionPage,
  removePlacement,
  revisions,
  uid,
  updateBlockLiveState,
} from '../../server/services/content.js';
import { submitRun } from '../../server/services/runs.js';
import { RunWorker } from '../../server/jobs/worker.js';
import { EventHub } from '../../server/sse/hub.js';

export function databaseFootprint(db: DB) {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const allocatedBytes = (db.pragma('page_count', { simple: true }) as number) * pageSize;
  const freeBytes = (db.pragma('freelist_count', { simple: true }) as number) * pageSize;
  return { allocatedBytes, freeBytes, liveBytes: allocatedBytes - freeBytes };
}

// Exercise history through real domain submission and finalization, without a provider.
// Call only on a disposable fixture database before its HTTP server starts.
export async function seedHistory(db: DB, actor: string, braneId: string, characters: number) {
  const initial = databaseFootprint(db);
  const source = createBlock(db, actor, 'text', { format: 'text', text: 's'.repeat(characters) });
  const snapshots = revisions(db);
  const snapshotRequests = 1000;
  for (let i = 0; i < snapshotRequests; i++) snapshots.snapshotBlock(actor, source.id);
  const unchanged = db
    .prepare(
      'SELECT count(*) revisions, sum(length(CAST(content_json AS BLOB))) contentBytes FROM block_revisions WHERE block_id=?',
    )
    .get(source.id) as { revisions: number; contentBytes: number };
  if (unchanged.revisions !== 1) throw new Error('Unchanged snapshots were duplicated');
  const afterSnapshots = databaseFootprint(db);

  const historyBlock = createBlock(db, actor, 'text', { format: 'text', text: '' });
  const historyVersions = 120;
  for (let version = 0; version < historyVersions; version++) {
    updateBlockLiveState(db, actor, {
      blockId: historyBlock.id,
      text: `${version}:`.padEnd(characters, 'h'),
      version,
    });
    snapshots.snapshotBlock(actor, historyBlock.id);
  }
  const afterVersions = databaseFootprint(db);
  const hub = new EventHub();
  const worker = new RunWorker(
    db,
    hub,
    async () => ({ text: 'Deterministic history fixture output.' }),
    { concurrency: 1, leaseMs: 5000, checkpointMs: 100, checkpointCharacters: 100 },
  );
  const limits = {
    models: ['mock'],
    maxTokens: 100,
    userConcurrency: 1,
    maxContextCharacters: 100000,
  };
  const lineage: { turns: number; inputRows: number; liveDatabaseBytes: number }[] = [];
  let continueFrom: string | undefined;
  let removedPlacements = 0;
  const finish = async (references: string[], prompt: string, parent?: string) => {
    const run = submitRun(
      db,
      snapshots,
      actor,
      { braneId, key: uid(), model: 'mock', prompt, references, edits: [], continueFrom: parent },
      limits,
    );
    worker.tick();
    const deadline = Date.now() + 5000;
    while (true) {
      const { status } = db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as {
        status: string;
      };
      if (status === 'completed') break;
      if (!['queued', 'claimed', 'running'].includes(status) || Date.now() > deadline)
        throw new Error(`History fixture run did not complete: ${status}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const placement = db
      .prepare('SELECT id FROM placements WHERE block_id=? AND brane_id=?')
      .get(run.output_block_id, braneId) as { id: string };
    removePlacement(db, actor, placement.id);
    removedPlacements++;
    return (
      db.prepare('SELECT message_id FROM run_outputs WHERE run_id=?').get(run.id) as {
        message_id: string;
      }
    ).message_id;
  };
  const chainTurns = 80;
  const independentRuns = 250;
  try {
    for (let turn = 1; turn <= chainTurns; turn++) {
      continueFrom = await finish(turn === 1 ? [source.id] : [], `Continue ${turn}`, continueFrom);
      if ([10, 40, chainTurns].includes(turn))
        lineage.push({
          turns: turn,
          inputRows: (db.prepare('SELECT count(*) n FROM run_inputs').get() as { n: number }).n,
          liveDatabaseBytes: databaseFootprint(db).liveBytes,
        });
    }
    for (let run = 0; run < independentRuns; run++)
      await finish([source.id], 'Independent history');
  } finally {
    await worker.stop();
    hub.close();
  }
  const remaining = (
    db.prepare('SELECT count(*) n FROM placements WHERE brane_id=?').get(braneId) as { n: number }
  ).n;
  if (remaining !== 0) throw new Error('Historical output placements were not removed');
  const afterRuns = databaseFootprint(db);
  // Reconstruct the previous endpoint shape on this same fixture for byte comparison.
  // This is a simulated payload baseline, not a timing measurement of older code.
  const legacyRows = db
    .prepare(
      'SELECT id,block_id,content_json,created_at FROM block_revisions WHERE block_id=? ORDER BY created_at DESC',
    )
    .all(historyBlock.id) as { content_json: string }[];
  const legacyHistoryBytes = Buffer.byteLength(
    JSON.stringify(legacyRows.map((row) => ({ ...row, content: JSON.parse(row.content_json) }))),
  );
  return {
    historyBlockId: historyBlock.id,
    snapshotRequests,
    unchanged,
    historyVersions,
    chainTurns,
    lineage,
    independentRuns,
    removedPlacements,
    legacyHistoryBytes,
    database: { initial, afterSnapshots, afterVersions, afterRuns },
  };
}

// Capture statement calls on this isolated read-only connection. SQLite's verbose
// trace truncates bound strings, so it cannot supply executable query-plan probes.
export function explainHistoryReads(path: string, actor: string, braneId: string, blockId: string) {
  const statements = new Map<string, unknown[]>();
  const db = new Database(path, { readonly: true });
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const get = statement.get.bind(statement),
      all = statement.all.bind(statement);
    statement.get = (...parameters: unknown[]) => {
      statements.set(sql, parameters);
      return get(...parameters);
    };
    statement.all = (...parameters: unknown[]) => {
      statements.set(sql, parameters);
      return all(...parameters);
    };
    return statement;
  }) as DB['prepare'];
  try {
    readBrane(db, actor, braneId);
    const first = readRevisionPage(db, actor, blockId);
    readRevisionPage(db, actor, blockId, 25, first.nextCursor!);
    return [...statements].map(([sql, parameters]) => ({
      sql,
      plan: (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[]).map(
        (row) => row.detail,
      ),
    }));
  } finally {
    db.close();
  }
}
