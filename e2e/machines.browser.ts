import { testProcessEnvironment } from '../tests/fixtures/process-environment';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scenarios 1 and 6 of docs/architecture/redo, each run through the built app and the
// mock model on both the redo's path and the composer's. Each user gesture (a click, a
// drag, a text entry or a key press; not a hover) is counted so the iteration log can
// compare them. Each scenario has its own server and account, so the polling below
// stays inside one account's request allowance.
const sources = [
  'Good transit raises rents because it makes places more valuable.',
  '2019 study: rents near new stations rose 8–12% against matched controls.',
  'Interview: “We moved out when the line opened — the landlord doubled it.”',
];
const critiquePrompt =
  'Find the strongest objection to the first card, using only the second. Answer in three sentences, then name the one fact that would settle it.';

test('a machine keeps a brief current with one press per update', async ({ page }) => {
  const counts = { machine: { build: 0, update: 0 }, ask: { build: 0, update: 0 } };
  await serve(page, 4201, async ({ seed, completed, state, api, origin }) => {
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
      const { braneId, cards } = await seed('Machine brief', sources);
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (work: () => Promise<unknown>) => {
        counts.machine.build++;
        await work();
      };
      // The Machine chip places a machine fed with the selection; its prompt is ready to edit.
      await act(() => marquee(page, cards));
      await act(() => page.getByRole('button', { name: 'Machine', exact: true }).click());
      const slot = page.locator('[data-feed-slot="cards"]');
      await expect(slot.locator('.slot-chip')).toHaveCount(3);
      const prompt = page.getByRole('textbox', { name: 'Machine prompt' });
      await act(() => prompt.fill('Write a five-sentence brief that reconciles {cards}.'));
      const lever = page.locator('.machine-lever');
      await expect(lever).toHaveText(/^Run/);
      await act(() => lever.click());
      await completed(braneId, 1);
      const first = (await state(braneId)).runs[0];
      expect(first.machine_block_id).toBeTruthy();
      const detail = await (await page.request.get(api(`/runs/${first.id}`))).json();
      expect(detail.inputs.map((i: { label: string }) => i.label)).toEqual([
        'cards',
        'cards',
        'cards',
        'Prompt',
      ]);
      await expect(page.locator('.machine-state')).toHaveText('ran');

      await editFirstSource(braneId, cards);
      await expect(page.locator('.machine-state')).toHaveText('stale · cards changed');
      await expect(page.locator('.react-flow__edge.feed-edge.stale')).toHaveCount(1);
      await expect(lever).toHaveText(/^Rerun/);
      counts.machine.update++;
      await lever.click();
      await completed(braneId, 2);
      await expect(page.locator('.machine-state')).toHaveText('ran');
      // The rerun's output takes the tray place; the first output is on its back.
      const after = await state(braneId);
      const output = after.placements.find(
        (p) => p.block_id === after.runs.find((r) => r.id !== first.id)!.output_block_id,
      )!;
      expect(output.host_placement_id).toBeNull();
      expect(
        after.placements.find((p) => p.block_id === first.output_block_id)?.host_placement_id,
      ).toBe(output.id);
      await expect(page.locator('.canvas-card.generated')).toHaveCount(1);
      await page.screenshot({ path: 'test-results/machine-flow.png' });
    }

    // Ask path: a one-off question over the same cards.
    {
      const { braneId, cards } = await seed('Asked brief', sources);
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (phase: 'build' | 'update', work: () => Promise<unknown>) => {
        counts.ask[phase]++;
        await work();
      };
      await act('build', () => marquee(page, cards));
      await act('build', () =>
        page.getByRole('button', { name: 'Ask about 3', exact: true }).click(),
      );
      await act('build', () =>
        page
          .getByRole('textbox', { name: 'Run prompt' })
          .fill('Write a five-sentence brief that reconciles these sources.'),
      );
      await act('build', () => page.getByRole('button', { name: 'Run ↗', exact: true }).click());
      await completed(braneId, 1);
      await editFirstSource(braneId, cards);
      // The response's receipt is on its back; its flip control is marked once an input changed.
      const response = page.locator('.react-flow__node:has(.canvas-card.generated)');
      await act('update', () =>
        response.getByRole('button', { name: /Show back · an input changed/ }).click(),
      );
      const before = await state(braneId);
      const asked = before.placements.find((p) => p.block_id === before.runs[0].output_block_id)!;
      // Update asks the question again in the answer's place; the old answer goes on its back.
      await act('update', () =>
        response.getByRole('button', { name: 'Update', exact: true }).click(),
      );
      await completed(braneId, 2);
      const after = await state(braneId);
      const updated = after.placements.find(
        (p) => p.block_id === after.runs.find((r) => r.id !== before.runs[0].id)!.output_block_id,
      )!;
      expect([updated.x, updated.y, updated.host_placement_id]).toEqual([asked.x, asked.y, null]);
      expect(after.placements.find((p) => p.id === asked.id)?.host_placement_id).toBe(updated.id);
      await expect(page.locator('.canvas-card.generated')).toHaveCount(1);
    }
  });
  record('brief', counts);
  expect(counts.machine.update).toBeLessThan(counts.ask.update);
});

test('Develop goes to the claim’s back and Critique arrives pre-fed', async ({ page }) => {
  const claimCards = sources.slice(0, 2);
  const counts = {
    redo: { actions: 0, typed: 0, tableCards: 0 },
    ask: { actions: 0, typed: 0, tableCards: 0 },
  };
  await serve(page, 4202, async ({ seed, completed, state, api, origin }) => {
    // The redo's path: Develop onto the claim's back, then Critique the claim with the
    // study as its evidence.
    {
      const { braneId, cards } = await seed('Claim, redo', claimCards);
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (work: () => Promise<unknown>) => {
        counts.redo.actions++;
        await work();
      };
      const claim = page.locator(`.react-flow__node[data-id="${cards[0].placementId}"]`);
      await act(() => claim.getByRole('button', { name: 'Card actions' }).click());
      await act(() => claim.getByRole('button', { name: 'Develop', exact: true }).click());
      await expect(claim.getByRole('button', { name: /Show front · 1 on the back/ })).toBeVisible();
      await expect(claim.locator('.back-item')).toContainText('Development');
      await completed(braneId, 1);
      expect(
        (await state(braneId)).placements.find((p) => p.host_placement_id === cards[0].placementId),
      ).toBeTruthy();
      await act(() => marquee(page, cards));
      await act(() => page.getByRole('button', { name: 'Critique', exact: true }).click());
      await expect(page.locator('[data-feed-slot="claim"] .slot-chip')).toHaveCount(1);
      await expect(page.locator('[data-feed-slot="evidence"] .slot-chip')).toHaveCount(1);
      await act(() => page.locator('.machine-lever').click());
      await completed(braneId, 2);
      const run = (await state(braneId)).runs.find((r) => r.machine_block_id)!;
      const detail = await (await page.request.get(api(`/runs/${run.id}`))).json();
      expect(detail.inputs.map((i: { label: string }) => i.label)).toEqual([
        'claim',
        'evidence',
        'Prompt',
      ]);
      await expect(page.locator('.canvas-card.generated')).toHaveCount(1);
      await arrow(page, act, braneId, state, run.output_block_id, cards[0]);
      counts.redo.tableCards = await page.locator('.react-flow__node').count();
      await page.screenshot({ path: 'test-results/claim-redo.png' });
      await expectRelationSent(page, api, braneId, [cards[0].id, run.output_block_id]);
    }

    // The Ask path: write the critique as a question.
    {
      const { braneId, cards } = await seed('Claim, asked', claimCards);
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (work: () => Promise<unknown>) => {
        counts.ask.actions++;
        await work();
      };
      const claim = page.locator(`.react-flow__node[data-id="${cards[0].placementId}"]`);
      await act(() => claim.getByRole('button', { name: 'Card actions' }).click());
      await act(() => claim.getByRole('button', { name: 'Develop', exact: true }).click());
      await completed(braneId, 1);
      await act(() => marquee(page, cards));
      await act(() => page.getByRole('button', { name: 'Ask about 2', exact: true }).click());
      counts.ask.typed = critiquePrompt.length;
      await act(() => page.getByRole('textbox', { name: 'Run prompt' }).fill(critiquePrompt));
      await act(() => page.getByRole('button', { name: 'Run ↗', exact: true }).click());
      await completed(braneId, 2);
      // The development is on the claim's back; the answer is the run on the table.
      const asked = await state(braneId);
      const answer = asked.runs.find((r) =>
        asked.placements.some((p) => p.block_id === r.output_block_id && !p.host_placement_id),
      )!;
      await arrow(page, act, braneId, state, answer.output_block_id, cards[0]);
      counts.ask.tableCards = await page.locator('.react-flow__node').count();
    }
  });
  record('claim', counts);
  expect(counts.redo.actions).toBeLessThan(counts.ask.actions);
});

test('Ask answers a region where it was asked, and Make reusable turns it into a machine', async ({
  page,
}) => {
  const counts = { actions: 0, typed: 0 };
  const question = 'What do these three cards agree on, and where do they disagree?';
  await serve(page, 4203, async ({ seed, completed, state, api, origin }) => {
    // One marquee, Ask, the question, Run.
    {
      const { braneId, cards } = await seed('Region, redo', sources);
      await page.goto(`${origin}/b/${braneId}`);
      const act = async (work: () => Promise<unknown>) => {
        counts.actions++;
        await work();
      };
      await act(() => marquee(page, cards));
      await act(() => page.getByRole('button', { name: 'Ask about 3', exact: true }).click());
      const box = page.getByRole('region', { name: 'Ask' });
      // Where the box stands on the table, from its node's transform.
      const spot = await page
        .locator('.react-flow__node[data-id^="ask:"]')
        .evaluate((node) => new DOMMatrix(getComputedStyle(node).transform));
      counts.typed = question.length;
      await act(() => box.getByRole('textbox', { name: 'Run prompt' }).fill(question));
      await act(() => box.getByRole('button', { name: 'Run ↗', exact: true }).click());
      await completed(braneId, 1);
      await expect(box).toHaveCount(0);
      const run = (await state(braneId)).runs[0];
      const detail = await (await page.request.get(api(`/runs/${run.id}`))).json();
      expect(detail.inputs.map((i: { kind: string }) => i.kind)).toEqual([
        'reference',
        'reference',
        'reference',
        'prompt',
      ]);
      // The answer stands where the box stood.
      const answer = page.locator('.react-flow__node:has(.canvas-card.generated)');
      const placed = (await state(braneId)).placements.find(
        (p) => p.block_id === run.output_block_id,
      )!;
      expect([placed.x, placed.y]).toEqual([spot.e, spot.f]);
      // Its back holds the question; Make reusable feeds the same cards.
      await answer.getByRole('button', { name: /Show back/ }).click();
      await expect(answer.getByRole('blockquote', { name: 'Question' })).toContainText(question);
      await answer.getByRole('button', { name: 'Make reusable' }).click();
      await expect(page.locator('[data-feed-slot="cards"] .slot-chip')).toHaveCount(3);
      await page.locator('.machine-lever').click();
      await completed(braneId, 2);
    }
  });
  record('region', counts);
});

// Drag the objection's port onto the claim and name the arrow: two gestures.
async function arrow(
  page: Page,
  act: (work: () => Promise<unknown>) => Promise<void>,
  braneId: string,
  state: Server['state'],
  objectionBlockId: string,
  claim: { placementId: string },
) {
  const objection = (await state(braneId)).placements.find(
    (p) => p.block_id === objectionBlockId && !p.host_placement_id,
  )!;
  const target = page.locator(`.react-flow__node[data-id="${claim.placementId}"]`);
  await page.locator(`.react-flow__node[data-id="${objection.id}"]`).hover();
  await act(() =>
    drag(
      page,
      `.react-flow__node[data-id="${objection.id}"] .card-port`,
      target.locator('.card-grip'),
    ),
  );
  await act(() =>
    page
      .getByRole('dialog', { name: 'Name the arrow' })
      .getByRole('button', { name: 'answers' })
      .click(),
  );
  await expect(page.locator('.relation-label')).toContainText('answers');
  await expect
    .poll(async () => (await state(braneId)).relations)
    .toEqual([
      expect.objectContaining({
        from_placement_id: objection.id,
        to_placement_id: claim.placementId,
        label: 'answers',
      }),
    ]);
}
// A run over both ends of the arrow sends it as a relation entry.
async function expectRelationSent(
  page: Page,
  api: Server['api'],
  braneId: string,
  references: string[],
) {
  const receipt = await (
    await page.request.post(api('/runs'), {
      data: {
        braneId,
        key: crypto.randomUUID(),
        model: 'mock',
        prompt: 'Which holds?',
        references,
      },
    })
  ).json();
  const detail = await (await page.request.get(api(`/runs/${receipt.runId}`))).json();
  expect(
    detail.inputs
      .filter((i: { kind: string }) => i.kind === 'relation')
      .map((i: { content: { text: string } }) => i.content.text),
  ).toEqual(['Reference 2 answers Reference 1.']);
}

// One reverse marquee from the empty table right of the cards selects all of them.
async function marquee(page: Page, cards: { placementId: string }[]) {
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const top = (await node(cards[0].placementId).boundingBox())!;
  const bottom = (await node(cards[cards.length - 1].placementId).boundingBox())!;
  await page.mouse.move(top.x + top.width + 60, top.y + 20);
  await page.mouse.down();
  await page.mouse.move(top.x + top.width - 30, bottom.y + bottom.height - 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: 'Selection' })).toContainText(
    `${cards.length} cards`,
  );
}

interface BraneRead {
  placements: {
    id: string;
    block_id: string;
    host_placement_id: string | null;
    x: number;
    y: number;
  }[];
  blocks: { id: string; kind: string; version: number }[];
  relations: { from_placement_id: string; to_placement_id: string; label: string }[];
  runs: { id: string; status: string; output_block_id: string; machine_block_id: string | null }[];
}
interface Server {
  origin: string;
  api: (path: string) => string;
  state: (braneId: string) => Promise<BraneRead>;
  seed: (
    title: string,
    texts: string[],
  ) => Promise<{ braneId: string; cards: { id: string; placementId: string }[] }>;
  completed: (braneId: string, count: number) => Promise<void>;
}
// Start the built server on its own database, sign up one account and run the scenario.
async function serve(page: Page, port: number, scenario: (server: Server) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-machines-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: testProcessEnvironment({
      PORT: String(port),
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
      (await (await page.request.get(api(`/branes/${braneId}`))).json()) as BraneRead;
    await scenario({
      origin,
      api,
      state,
      async seed(title, texts) {
        const brane = await (await page.request.post(api('/branes'), { data: { title } })).json();
        const cards: { id: string; placementId: string }[] = [];
        for (const [index, text] of texts.entries()) {
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
          const placement = (await state(brane.id)).placements.find(
            (p) => p.block_id === block.id,
          )!;
          cards.push({ id: block.id, placementId: placement.id });
        }
        return { braneId: brane.id as string, cards };
      },
      completed: (braneId, count) =>
        expect
          .poll(
            async () => (await state(braneId)).runs.filter((r) => r.status === 'completed').length,
            { timeout: 20_000 },
          )
          .toBe(count),
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function record(scenario: string, counts: unknown) {
  mkdirSync('test-results/machine-actions', { recursive: true });
  writeFileSync(`test-results/machine-actions/${scenario}.json`, JSON.stringify(counts, null, 2));
}

async function drag(page: Page, from: string, to: Locator) {
  const start = await page.locator(from).boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('Feed endpoints are not visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}
