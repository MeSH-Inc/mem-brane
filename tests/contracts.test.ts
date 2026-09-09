import { expect, it } from 'vitest';
import { createClient, InvalidApiResponse } from '../src/services/client';
import { configurationResponse, workspaceResponse, runDetailResponse } from '../shared/contracts';

it('rejects malformed configuration, workspace and run responses at the HTTP boundary', async () => {
  const client = createClient(async () => ({}));
  await expect(client.configuration()).rejects.toBeInstanceOf(InvalidApiResponse);
  await expect(client.workspace('b')).rejects.toThrow('/branes/b');
  await expect(client.run('r')).rejects.toThrow('/runs/r');
});
it('requires complete contracts instead of accepting plausible partial fixtures', () => {
  expect(configurationResponse.safeParse({ models: ['mock'], defaultModel: 'mock' }).success).toBe(
    false,
  );
  expect(
    workspaceResponse.safeParse({
      brane: {},
      blocks: [],
      placements: [],
      runs: [],
      derivations: [],
    }).success,
  ).toBe(false);
  expect(runDetailResponse.safeParse({ id: 'r', inputs: [], cost: null }).success).toBe(false);
});
it('rejects invalid text acknowledgements and preserves the operation-specific error', async () => {
  const client = createClient(async () => ({
    version: '1',
    content: { format: 'text', text: 'Saved' },
  }));
  await expect(client.saveText({ blockId: 'b', text: 'Saved', version: 0 })).rejects.toThrow(
    '/blocks/live',
  );
});
