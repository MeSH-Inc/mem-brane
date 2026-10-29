import { testProcessEnvironment } from '../tests/fixtures/process-environment';
import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scenario 6 of docs/architecture/redo: keep a brief current while its sources change.
// Both paths run through the built app and the mock model; each user gesture is counted
// so the iteration log can compare the machine with the composer it would replace.
const sources = [
  'Good transit raises rents because it makes places more valuable.',
  '2019 study: rents near new stations rose 8–12% against matched controls.',
  'Interview: “We moved out when the line opened — the landlord doubled it.”',
];

test('a machine keeps a brief current with one press per update', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-machines-'));
  const origin = 'http://127.0.0.1:4183';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: testProcessEnvironment({
      PORT: '4183',
      APP_ORIGIN: origin,
      DATABASE_PATH: join(directory, 'db.sqlite'),
      ASSET_DIRECTORY: join(directory, 'assets'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const counts = { machine: { build: 0, update: 0 }, composer: { build: 0, update: 0 } };
  try {
    await expect.poll(() => output).toContain('mem-brane API');
    expect(
      (
        await page.request.post(`${origin}/api/auth/sign-up/email`, {
          data: { name: 'Machines', email: 'machines@example.com', password: 'machines-password' },
          headers: { origin },
        })
      ).ok(),
    ).toBeTruthy();
    const api = (path: string) => `${origin}/api${path}`;
    const state = async (braneId: string) =>
      (await (await page.request.get(api(`/branes/${braneId}`))).json()) as {
        placements: { id: string; block_id: string }[];
        blocks: { id: string; kind: string; version: number }[];
        runs: { id: string; status: string; machine_block_id: string | null }[];
      };
    async function seed(title: string) {
      const brane = await (await page.request.post(api('/branes'), { data: { title } })).json();
      const cards: { id: string; placementId: string }[] = [];
      for (const [index, text] of sources.entries()) {
        const block = await (
          await page.request.post(api('/blocks/text'), {
            data: {
              braneId: brane.id,
              geometry: { x: 40, y: 40 + index * 230, width: 320, height: 190 },
            },
          })
        ).json();
        await page.request.patch(api('/blocks/live'), {
          data: { blockId: block.id, text, version: 0 },
        });
        const placement = (await state(brane.id)).placements.find((p) => p.block_id === block.id)!;
        cards.push({ id: block.id, placementId: placement.id });
      }
      return { braneId: brane.id as string, cards };
    }
    const completed = (braneId: string, count: number) =>
      expect
        .poll(
          async () => (await state(braneId)).runs.filter((r) => r.status === 'completed').length,
          {
            timeout: 20_000,
          },
        )
        .toBe(count);
    async function editFirstSource(braneId: string, cards: { placementId: string }[]) {
      const editor = page
        .locator(`.react-flow__node[data-id="${cards[0].placementId}"]`)
        .getByRole('textbox', { name: 'Block text' });
      await editor.fill(`${sources[0]} Land sales show the rise began at announcement.`);
      await expect
        .poll(async () => (await state(braneId)).blocks.find((b) => b.kind === 'text')?.version)
        .toBe(2);
    }

    // Machine path.
    {
      const { braneId, cards } = await seed('Machine brief');
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (work: () => Promise<unknown>) => {
        counts.machine.build++;
        await work();
      };
      await act(() => page.getByText('＋ Add').click());
      await act(() => page.getByRole('button', { name: '⚙ Machine' }).click());
      const prompt = page.getByRole('textbox', { name: 'Machine prompt' });
      await expect(prompt).toBeVisible();
      await act(() => prompt.fill('Write a five-sentence brief that reconciles {sources}.'));
      const slot = page.locator('[data-feed-slot="sources"]');
      await expect(slot).toBeVisible();
      for (const card of cards)
        await act(() =>
          drag(page, `.react-flow__node[data-id="${card.placementId}"] .feed-port`, slot),
        );
      await expect(slot.locator('.slot-chip')).toHaveCount(3);
      const lever = page.locator('.machine-lever');
      await expect(lever).toHaveText(/^Run/);
      await act(() => lever.click());
      await completed(braneId, 1);
      const run = (await state(braneId)).runs[0];
      expect(run.machine_block_id).toBeTruthy();
      const detail = await (await page.request.get(api(`/runs/${run.id}`))).json();
      expect(detail.inputs.map((i: { label: string }) => i.label)).toEqual([
        'sources',
        'sources',
        'sources',
        'Prompt',
      ]);
      await expect(page.locator('.machine-state')).toHaveText('ran');

      await editFirstSource(braneId, cards);
      await expect(page.locator('.machine-state')).toHaveText('stale · sources changed');
      await expect(page.locator('.react-flow__edge.feed-edge.stale')).toHaveCount(1);
      await expect(lever).toHaveText(/^Rerun/);
      counts.machine.update++;
      await lever.click();
      await completed(braneId, 2);
      await expect(page.locator('.machine-state')).toHaveText('ran');
      await page.screenshot({ path: 'test-results/machine-flow.png' });
    }

    // Composer path, the interface the machine would replace.
    {
      const { braneId, cards } = await seed('Composer brief');
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (phase: 'build' | 'update', work: () => Promise<unknown>) => {
        counts.composer[phase]++;
        await work();
      };
      for (const card of cards) {
        const node = page.locator(`.react-flow__node[data-id="${card.placementId}"]`);
        await node.locator('.card-grip').hover();
        await act('build', () => node.getByRole('button', { name: '+ Use as context' }).click());
      }
      await act('build', () =>
        page
          .getByRole('textbox', { name: 'Run prompt' })
          .fill('Write a five-sentence brief that reconciles these sources.'),
      );
      await act('build', () => page.getByRole('button', { name: 'Run ↗', exact: true }).click());
      await completed(braneId, 1);
      await editFirstSource(braneId, cards);
      await act('update', () =>
        page.getByRole('button', { name: 'Reuse with current sources' }).click(),
      );
      await act('update', () => page.getByRole('button', { name: 'Run ↗', exact: true }).click());
      await completed(braneId, 2);
    }
    writeFileSync('test-results/machine-actions.json', JSON.stringify(counts, null, 2));
    expect(counts.machine.update).toBeLessThan(counts.composer.update);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

async function drag(page: Page, from: string, to: import('@playwright/test').Locator) {
  const start = await page.locator(from).boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('Feed endpoints are not visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}
