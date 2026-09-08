// Isolated complexity probe. CLI VM steps supplement plans from better-sqlite3;
// both SQLite versions are recorded because they may use different planners.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, type DB } from '../server/db/index.js';
import {
  createBrane,
  createTextBlock,
  readBrane,
  removePlacement,
  revisions,
  uid,
} from '../server/services/content.js';
import { readRunPage } from '../server/services/run-reads.js';
import { spawnArtifact, submitRun } from '../server/services/runs.js';
import { seedHistory, databaseFootprint } from './fixtures/history.js';

const output = process.argv[2];
if (!output)
  throw new Error('Usage: NODE_ENV=test node --import tsx scripts/read-scaling.ts /report.json');
const cli =
  process.env.SQLITE_CLI ?? (process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3');
const cliVersion = execFileSync(cli, ['-version'], { encoding: 'utf8' }).trim();
const results: {
  removedOutputs: number;
  sqlite: unknown;
  database: ReturnType<typeof databaseFootprint>;
  workspaceBytes: number;
  queries: { sql: string; vmSteps: number; plan: string[] }[];
}[] = [];
for (const hidden of [0, 2500]) {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-read-scaling-'));
  const path = join(directory, 'fixture.sqlite');
  const db = openDatabase(path);
  try {
    const actor = uid();
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      actor,
      'Scaling',
      `${actor}@example.com`,
      0,
      0,
    );
    const braneId = createBrane(db, actor).id;
    await seedHistory(db, actor, braneId, 100, hidden);
    const source = createTextBlock(db, actor, braneId);
    const limits = {
      models: ['mock'],
      maxTokens: 100,
      userConcurrency: 3,
      maxContextCharacters: 100000,
    };
    spawnArtifact(
      db,
      revisions(db),
      actor,
      {
        braneId,
        key: uid(),
        model: 'mock',
        action: 'develop',
        sourceBlockIds: [source.id],
        anchorPlacementId: source.placement.id,
        edits: [],
      },
      limits,
    );
    const unplaced = submitRun(
      db,
      revisions(db),
      actor,
      { braneId, key: uid(), model: 'mock', prompt: 'Unplaced active', references: [], edits: [] },
      limits,
    );
    const placement = db
      .prepare('SELECT id FROM placements WHERE block_id=?')
      .get(unplaced.output_block_id) as { id: string };
    removePlacement(db, actor, placement.id);
    const queries = new Map<string, unknown[]>();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql),
        get = statement.get.bind(statement),
        all = statement.all.bind(statement);
      statement.get = (...parameters: unknown[]) => {
        queries.set(sql, parameters);
        return get(...parameters);
      };
      statement.all = (...parameters: unknown[]) => {
        queries.set(sql, parameters);
        return all(...parameters);
      };
      return statement;
    }) as DB['prepare'];
    const state = readBrane(db, actor, braneId);
    const page = readRunPage(db, actor, braneId);
    if (
      state.runs.length !== 2 ||
      state.derivations.length !== 1 ||
      state.blocks.length !== 2 ||
      page.items.length !== 25
    )
      throw new Error('Unexpected visible/history projection');
    db.prepare = prepare;
    const metrics = [...queries].map(([sql, parameters]) => {
      let parameter = 0;
      const bound = sql.replace(/\?/g, () => {
        const value = parameters[parameter++];
        return typeof value === 'number'
          ? String(value)
          : `'${String(value).replaceAll("'", "''")}'`;
      });
      const result = execFileSync(cli, ['-readonly', path, '.stats vmstep', bound], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      const steps = /VM-steps: (\d+)/.exec(result);
      if (!steps) throw new Error('SQLite CLI must support .stats vmstep');
      return {
        sql,
        vmSteps: Number(steps[1]),
        plan: (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[]).map(
          (row) => row.detail,
        ),
      };
    });
    results.push({
      removedOutputs: hidden + 80,
      sqlite: db.prepare('SELECT sqlite_version() version').get(),
      database: databaseFootprint(db),
      workspaceBytes: Buffer.byteLength(JSON.stringify(state)),
      queries: metrics,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const comparisons = results[0].queries.map((small, index) => {
  const large = results[1].queries[index];
  if (small.sql !== large.sql || large.vmSteps > small.vmSteps + 25)
    throw new Error('Read work grew with removed history');
  return { sql: small.sql, smallVmSteps: small.vmSteps, largeVmSteps: large.vmSteps };
});
const report = {
  time: new Date().toISOString(),
  node: process.version,
  cliVersion,
  results,
  comparisons,
};
writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, comparisons }, null, 2));
