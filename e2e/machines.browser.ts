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

test('a reading pile becomes a stack and feeds a machine as one', async ({ page }) => {
  const counts = { actions: 0 };
  await serve(page, 4204, async ({ seed, completed, state, api, origin }) => {
    const papers = Array.from({ length: 12 }, (_, i) => `Paper ${i + 1}: one finding.`);
    // Twelve dropped files stand on the table in a grid; dropping them is one gesture.
    const { braneId, cards } = await seed('Reading pile', papers, (index) => ({
      x: 40 + (index % 4) * 220,
      y: 40 + Math.floor(index / 4) * 140,
      width: 200,
      height: 120,
    }));
    counts.actions++;
    // Split stands ready on the table, as the Workshop will place it.
    const split = await (
      await page.request.post(api('/blocks/machine'), {
        data: {
          braneId,
          geometry: { x: 980, y: 40, width: 400, height: 300 },
          template: 'Split {text} into one card per idea.',
        },
      })
    ).json();
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    const frame = page.getByRole('region', { name: 'Group 1' });
    await expect(frame).toContainText('12 cards');
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    await expect(frame).toContainText('Stack · 12');
    // The pile takes the first paper's space, and moves as one from any of its cards.
    await expect
      .poll(async () => {
        const placed = (await state(braneId)).placements.filter((p) =>
          cards.some((c) => c.placementId === p.id),
        );
        return new Set(placed.map((p) => `${p.width}x${p.height}`)).size;
      })
      .toBe(1);
    await act(() =>
      drag(page, '.group-header .card-port', page.locator('[data-feed-slot="text"]')),
    );
    await expect(page.locator('[data-feed-slot="text"] .slot-chip')).toHaveText(/Group 1 · 12/);
    await page.locator('.machine-lever').click();
    await completed(braneId, 1);
    const run = (await state(braneId)).runs[0];
    const detail = await (await page.request.get(api(`/runs/${run.id}`))).json();
    // The stack sends its members in reading order, each under the slot it fills.
    expect(
      detail.inputs
        .filter((i: { kind: string }) => i.kind === 'reference')
        .map((i: { label: string; content: { text: string } }) => [i.label, i.content.text]),
    ).toEqual(papers.map((text) => ['text', text]));
    // A member taken out of the stack makes the machine stale. The output was revealed
    // beside the machine; bring the stack back into view first.
    await page.locator('.react-flow__controls-fitview').click();
    const top = page.locator(`.react-flow__node[data-id="${cards[0].placementId}"]`);
    await top.getByRole('button', { name: 'Card actions' }).click();
    await top.getByRole('button', { name: 'Take out of group' }).click();
    await expect(page.locator('.machine-state')).toHaveText('stale · text changed');
    await expect(frame).toContainText('Stack · 11');
    expect(split.id).toBeTruthy();
  });
  record('pile', counts);
});

test('a grouped region is asked about, and its answer goes stale when an arrow changes', async ({
  page,
}) => {
  const counts = { actions: 0, typed: 0 };
  const question = 'What do these three cards agree on, and where do they disagree?';
  await serve(page, 4205, async ({ seed, completed, state, origin }) => {
    const { braneId, cards } = await seed('Grouped region', sources);
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    // The arrow is drawn before the question; it is not part of the count.
    await arrow(page, async (work) => void (await work()), braneId, state, cards[1].id, cards[0]);
    await act(() => marquee(page, cards));
    await act(() => page.keyboard.press('g'));
    await expect(page.getByRole('region', { name: 'Group 1' })).toContainText('3 cards');
    // Renaming is a label change only; it is not part of the count.
    await page.getByRole('button', { name: 'Rename Group 1' }).click();
    await page.getByRole('textbox', { name: 'Group name' }).fill('Rent evidence');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Rent evidence' })).toContainText('3 cards');
    await expect
      .poll(async () => (await state(braneId)).groups.map((g) => g.label))
      .toEqual(['Rent evidence']);
    await act(() => page.getByRole('button', { name: 'Ask about 3', exact: true }).click());
    counts.typed = question.length;
    const box = page.getByRole('region', { name: 'Ask' });
    await act(() => box.getByRole('textbox', { name: 'Run prompt' }).fill(question));
    await act(() => box.getByRole('button', { name: 'Run ↗', exact: true }).click());
    await completed(braneId, 1);
    // The answer's back lists the arrow it sent.
    const answer = page.locator('.react-flow__node:has(.canvas-card.generated)');
    await answer.getByRole('button', { name: /Show back/ }).click();
    await expect(answer.getByRole('list', { name: 'Arrows sent' })).toContainText(
      'answers Good transit raises rents',
    );
    await expect(answer.getByRole('button', { name: 'Update' })).toHaveCount(0);
    // Rewording the arrow changes what asking again would send: Update appears.
    await page.locator('.relation-word').click();
    await page
      .getByRole('dialog', { name: 'Change the arrow’s word' })
      .getByRole('button', { name: 'contradicts' })
      .click();
    await expect(page.locator('.relation-word')).toHaveText('contradicts');
    await expect
      .poll(async () => (await state(braneId)).relations.map((r) => r.label))
      .toEqual(['contradicts']);
    await expect(answer.getByRole('button', { name: 'Update' })).toBeVisible();
    // Focus lists the arrow where it is not drawn.
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.getByRole('button', { name: /Good transit raises rents/ }).click();
    const arrows = page.getByRole('region', { name: 'Arrows' });
    await expect(arrows).toContainText('contradicts this card');
    await arrows.getByRole('button', { name: 'Remove arrow “contradicts”' }).click();
    await expect.poll(async () => (await state(braneId)).relations).toEqual([]);
  });
  record('grouped-region', counts);
});

test('a stack fed each runs Extract once per paper and the outputs arrive as a stack', async ({
  page,
}) => {
  const counts = { actions: 0 };
  await serve(page, 4206, async ({ seed, completed, state, api, origin }) => {
    const papers = Array.from({ length: 12 }, (_, i) => `Paper ${i + 1}: one finding.`);
    const { braneId, cards } = await seed('Pile, each', papers, grid);
    counts.actions++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    const extract = await takeOut(page, act, state, braneId, 'Extract');
    await act(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"] .card-port',
        extract.locator('[data-feed-slot="source"]'),
      ),
    );
    await act(() => extract.getByRole('button', { name: /one card at a time/ }).click());
    const lever = extract.locator('.machine-lever');
    await expect(lever).toHaveText(/^Run ×12/);
    await act(() => lever.click());
    await completed(braneId, 12);
    const read = await state(braneId);
    expect(new Set(read.runs.map((r) => r.batch_id)).size).toBe(1);
    // Each run sent one paper, in the stack's order; the outputs are one stack.
    const ordered = [...read.runs].sort((a, b) => a.batch_position! - b.batch_position!);
    const first = await (await page.request.get(api(`/runs/${ordered[0].id}`))).json();
    const last = await (await page.request.get(api(`/runs/${ordered[11].id}`))).json();
    expect(first.inputs[0].content.text).toBe(papers[0]);
    expect(last.inputs[0].content.text).toBe(papers[11]);
    await expect(page.getByRole('region', { name: 'Each source' })).toContainText('Stack · 12');
    await expect(extract.locator('.machine-state')).toHaveText('ran');
  });
  record('pile-each', counts);
});

test('three Extract machines over one stack make a stack of answers each', async ({ page }) => {
  const counts = { actions: 0, typed: 0 };
  const questions = ['what method it uses', 'its sample size', 'its main finding'];
  await serve(page, 4207, async ({ seed, completed, state, origin }) => {
    const papers = Array.from({ length: 4 }, (_, i) => `Paper ${i + 1}: survey of 40 cities.`);
    const { braneId, cards } = await seed('Matrix', papers, grid);
    counts.actions++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    for (const [index, question] of questions.entries()) {
      const extract = await takeOut(page, act, state, braneId, 'Extract');
      const prompt = `From {source}, answer in one short sentence: ${question}?`;
      counts.typed += prompt.length;
      await act(() => extract.getByRole('textbox', { name: 'Machine prompt' }).fill(prompt));
      // The new machine was brought into view; fitting the view brings the stack back too.
      await page.locator('.react-flow__controls-fitview').click();
      await act(() =>
        drag(
          page,
          '.react-flow__node[data-id^="group:"]:has([aria-label="Group 1"]) .card-port',
          extract.locator('[data-feed-slot="source"]'),
        ),
      );
      await act(() => extract.getByRole('button', { name: /one card at a time/ }).click());
      await expect(extract.locator('.machine-lever')).toHaveText(/^Run ×4/);
      await act(() => extract.locator('.machine-lever').click());
      await completed(braneId, 4 * (index + 1));
    }
    const read = await state(braneId);
    expect(new Set(read.runs.map((r) => r.batch_id)).size).toBe(3);
    await expect(page.getByRole('region', { name: 'Each source' })).toHaveCount(3);
  });
  record('matrix', counts);
});

// Take a machine out of the Workshop: Add, Workshop, the machine. Returns its node.
async function takeOut(
  page: Page,
  act: (work: () => Promise<unknown>) => Promise<void>,
  state: Server['state'],
  braneId: string,
  name: string,
) {
  const before = new Set(
    (await state(braneId)).blocks.filter((b) => b.kind === 'machine').map((b) => b.id),
  );
  await act(() => page.getByRole('button', { name: '＋ Add' }).click());
  await act(() => page.getByRole('button', { name: '⚒ Workshop' }).click());
  await act(() =>
    page
      .getByRole('region', { name: 'Workshop' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .first()
      .click(),
  );
  let placementId = '';
  await expect
    .poll(async () => {
      const read = await state(braneId);
      const block = read.blocks.find((b) => b.kind === 'machine' && !before.has(b.id));
      placementId = read.placements.find((p) => p.block_id === block?.id)?.id ?? '';
      return placementId;
    })
    .not.toBe('');
  return page.locator(`.react-flow__node[data-id="${placementId}"]`);
}
// Papers dropped in a grid, four to a row.
const grid = (index: number) => ({
  x: 40 + (index % 4) * 220,
  y: 40 + Math.floor(index / 4) * 140,
  width: 200,
  height: 120,
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

// One marquee across a grid of cards, from the empty table beyond its right edge.
async function lasso(page: Page, cards: { placementId: string }[]) {
  const boxes = await Promise.all(
    cards.map(
      async (c) =>
        (await page.locator(`.react-flow__node[data-id="${c.placementId}"]`).boundingBox())!,
    ),
  );
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const top = Math.min(...boxes.map((b) => b.y));
  const left = Math.min(...boxes.map((b) => b.x));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  await page.mouse.move(right + 40, top - 10);
  await page.mouse.down();
  await page.mouse.move(left + 20, bottom - 20, { steps: 10 });
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
    width: number;
    height: number;
  }[];
  blocks: { id: string; kind: string; version: number }[];
  relations: { from_placement_id: string; to_placement_id: string; label: string }[];
  groups: { label: string; members: string[] }[];
  runs: {
    id: string;
    status: string;
    output_block_id: string;
    machine_block_id: string | null;
    batch_id: string | null;
    batch_position: number | null;
  }[];
}
interface Server {
  origin: string;
  api: (path: string) => string;
  state: (braneId: string) => Promise<BraneRead>;
  seed: (
    title: string,
    texts: string[],
    layout?: (index: number) => { x: number; y: number; width: number; height: number },
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
      async seed(title, texts, layout) {
        const brane = await (await page.request.post(api('/branes'), { data: { title } })).json();
        const cards: { id: string; placementId: string }[] = [];
        for (const [index, text] of texts.entries()) {
          const block = await (
            await page.request.post(api('/blocks/text'), {
              data: {
                braneId: brane.id,
                geometry: layout?.(index) ?? {
                  x: 40,
                  y: 40 + index * 230,
                  width: 320,
                  height: 190,
                },
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
  // A view that was just fitted or moved draws its new positions on the next frames.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const start = await page.locator(from).boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error('Feed endpoints are not visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}
