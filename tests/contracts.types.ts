// Compiled by `npm run typecheck`: these negative checks fail if any leaks back in.
import { expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { submitRun, spawnArtifact } from '../shared/schemas';
import type { SubmitRun, SubmitRunRequest, SpawnArtifact } from '../shared/types/domain';
import type { Configuration, RunDetail } from '../shared/contracts';
import { api } from '../src/services/api';
import { client } from '../src/services/client';
import { requireOwned } from '../server/domain/access';
import type { DB } from '../server/db';
expectTypeOf<SubmitRun>().toEqualTypeOf<z.output<typeof submitRun>>();
expectTypeOf<SubmitRunRequest>().toEqualTypeOf<z.input<typeof submitRun>>();
expectTypeOf<SpawnArtifact>().toEqualTypeOf<z.output<typeof spawnArtifact>>();
expectTypeOf<Awaited<ReturnType<typeof api>>>().toEqualTypeOf<unknown>();
expectTypeOf<Awaited<ReturnType<typeof client.configuration>>>().toEqualTypeOf<Configuration>();
expectTypeOf<Awaited<ReturnType<typeof client.run>>>().toEqualTypeOf<RunDetail>();
export async function contractChecks(db: DB) {
  const raw = await api('/config');
  // @ts-expect-error Transport JSON must be decoded before reading fields.
  raw.models;
  // @ts-expect-error Callers cannot supply unchecked HTTP response types.
  await api<Configuration>('/config');
  // @ts-expect-error Run input has required prompt and reference fields.
  client.submit({ braneId: 'b', key: 'k', model: 'mock' });
  client.spawn({
    braneId: 'b',
    key: 'k',
    model: 'mock',
    // @ts-expect-error Spawn source order is an array, not a scalar ID.
    sourceBlockIds: 'source',
    action: 'develop',
    anchorPlacementId: 'p',
  });
  const run = requireOwned(db, 'runs', 'actor', 'run');
  expectTypeOf(run.model).toEqualTypeOf<string>();
  expectTypeOf(run.lease_until).toEqualTypeOf<number | null>();
  // @ts-expect-error A run record cannot be used as a brane record.
  run.title;
  const brane = requireOwned(db, 'branes', 'actor', 'brane');
  expectTypeOf(brane.title).toEqualTypeOf<string>();
  // @ts-expect-error Row types follow the selected table.
  brane.options_json;
  const detail = await client.run('run');
  // @ts-expect-error Internal lease state is not part of the public inspection contract.
  detail.lease_owner;
}
