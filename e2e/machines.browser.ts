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

test('three Extract machines over one stack make a literature matrix, and a Brief reads it', async ({
  page,
}) => {
  const counts = { actions: 0, typed: 0, brief: 0 };
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
    // The first Extract comes from the Workshop and is fed and set to each; the second
    // and third are duplicates of it, fed the same way, with their own question.
    let previous: Locator | undefined;
    for (const [index, question] of questions.entries()) {
      const prompt = `From {source}, answer in one short sentence: ${question}?`;
      counts.typed += prompt.length;
      let extract: Locator;
      if (!previous) {
        extract = await takeOut(page, act, state, braneId, 'Extract');
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
      } else {
        extract = await duplicate(page, act, state, braneId, previous);
        await act(() => extract.getByRole('textbox', { name: 'Machine prompt' }).fill(prompt));
      }
      previous = extract;
      await expect(extract.locator('.machine-lever')).toHaveText(/^Run ×4/);
      await act(() => extract.locator('.machine-lever').click());
      await completed(braneId, 4 * (index + 1));
    }
    const read = await state(braneId);
    expect(new Set(read.runs.map((r) => r.batch_id)).size).toBe(3);
    await expect(page.getByRole('region', { name: 'Each source' })).toHaveCount(3);
    // Lasso the three stacks of answers, group them, and set them out as a matrix.
    await page.locator('.react-flow__controls-fitview').click();
    const outputs = read.runs.map((run) => ({
      placementId: read.placements.find((p) => p.block_id === run.output_block_id)!.id,
    }));
    // From below, so the rectangle reaches the answers and not the papers above them.
    await act(() => lasso(page, outputs, 'below'));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Matrix', exact: true }).click());
    const matrix = page.locator('[aria-roledescription="group"]').filter({ hasText: '4 × 3' });
    await expect(matrix).toHaveCount(1);
    await expect(matrix.getByRole('columnheader')).toHaveText(
      questions.map((q) => `${q.charAt(0).toUpperCase()}${q.slice(1)}?`),
    );
    await expect(matrix.getByRole('rowheader')).toHaveText(papers);
    // One row per paper: each paper's three answers stand level, one column per question.
    await expect
      .poll(
        async () => {
          const after = await state(braneId);
          const at = new Map(after.placements.map((p) => [p.block_id, p]));
          const rows = new Map<number, Set<number>>();
          for (const run of after.runs) {
            const ys = rows.get(run.batch_position!) ?? new Set<number>();
            ys.add(at.get(run.output_block_id)!.y);
            rows.set(run.batch_position!, ys);
          }
          return [...rows.values()].map((ys) => ys.size);
          // Slowly: the account's requests share one rate limit with the page's saves.
        },
        { intervals: [1000] },
      )
      .toEqual([1, 1, 1, 1]);
    // A Brief over the whole matrix: the matrix's port feeds its twelve answers.
    const briefAct = async (work: () => Promise<unknown>) => {
      counts.brief++;
      await work();
    };
    const brief = await takeOut(page, briefAct, state, braneId, 'Brief');
    await page.locator('.react-flow__controls-fitview').click();
    await briefAct(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"]:has(.group-frame.matrix) .card-port',
        brief.locator('[data-feed-slot="material"]'),
      ),
    );
    await expect(brief.locator('.slot-chip')).toContainText('· 12');
    await briefAct(() => brief.locator('.machine-lever').click());
    await completed(braneId, 13);
    await expect(brief.locator('.machine-state')).toHaveText('ran');
  });
  record('matrix', counts);
});

test('two models answer one press side by side, and Keep chooses one', async ({ page }) => {
  const counts = { actions: 0 };
  await serve(page, 4209, async ({ seed, completed, state, api, origin }) => {
    const { braneId, cards } = await seed('Pick a model', [
      'Cities that announced a transit line saw land prices rise. The rise began early.',
    ]);
    const machine = await (
      await page.request.post(api('/blocks/machine'), {
        data: {
          braneId,
          geometry: { x: 420, y: 40, width: 400, height: 300 },
          template: 'Summarise {source} for a council briefing.',
        },
      })
    ).json();
    let read = await state(braneId);
    const machinePlacement = read.placements.find((p) => p.block_id === machine.id)!.id;
    await page.request.post(api('/feeds'), {
      data: {
        braneId,
        fromPlacementId: cards[0].placementId,
        toPlacementId: machinePlacement,
        slot: 'source',
      },
    });
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    const node = page.locator(`.react-flow__node[data-id="${machinePlacement}"]`);
    // The models to compare are chosen on the machine's back, and pressed from there.
    await act(() => node.getByRole('button', { name: 'Show back' }).click());
    await expect(node.getByLabel('Presses')).toContainText('Not run yet.');
    const picker = node.getByRole('group', { name: 'Compare models on the next press' });
    await act(() => picker.getByRole('checkbox', { name: 'Local mock' }).check());
    await act(() => picker.getByRole('checkbox', { name: 'mock-brief' }).check());
    await expect(node.locator('.machine-lever')).toHaveText(/^Run ×2 models/);
    await act(() => node.locator('.machine-lever').click());
    await completed(braneId, 2);
    // The choice applied to that press only; the back lists the press.
    await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await expect(node.locator('.machine-presses li')).toHaveCount(1);
    await expect(node.locator('.machine-presses li')).toContainText('Local mock · mock-brief');
    await expect(node.locator('.machine-presses li')).toContainText('2 runs, done');
    await node.screenshot({ path: 'test-results/machine-back.png' });
    read = await state(braneId);
    const answers = read.runs.map((run) => ({
      run,
      placement: read.placements.find((p) => p.block_id === run.output_block_id)!,
    }));
    expect(answers.map((a) => a.run.model).sort()).toEqual(['mock', 'mock-brief']);
    expect(answers[0].placement.y).toBe(answers[1].placement.y);
    const brief = answers.find((a) => a.run.model === 'mock-brief')!;
    const other = answers.find((a) => a.run.model === 'mock')!;
    await expect(page.locator('.keep-button')).toHaveCount(2);
    await act(() => page.getByRole('button', { name: 'Keep the mock-brief answer' }).click());
    await expect
      .poll(async () => {
        read = await state(braneId);
        return read.placements.find((p) => p.id === other.placement.id)!.host_placement_id;
      })
      .toBe(brief.placement.id);
    await expect(page.getByRole('button', { name: /^Keep the/ })).toHaveCount(0);
    await expect(
      page
        .locator(`.react-flow__node[data-id="${brief.placement.id}"]`)
        .getByRole('button', { name: /1 on the back/ }),
    ).toBeVisible();
  });
  record('compare-models', counts);
});

test('sources feed Distill, Brief is fed from Distill, and an edit reruns the chain in one press', async ({
  page,
}) => {
  const counts = { build: 0, update: 0, keep: 0, typed: 0 };
  await serve(page, 4210, async ({ seed, completed, state, origin }) => {
    const { braneId, cards } = await seed('Chain', sources, grid);
    counts.build++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (phase: 'build' | 'update' | 'keep', work: () => Promise<unknown>) => {
      counts[phase]++;
      await work();
    };
    const build = (work: () => Promise<unknown>) => act('build', work);
    await build(() => lasso(page, cards));
    await build(() => page.keyboard.press('g'));
    await build(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    const distill = await takeOut(page, build, state, braneId, 'Distill');
    const distillPlacement = (await distill.getAttribute('data-id'))!;
    await build(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"] .card-port',
        distill.locator('[data-feed-slot="material"]'),
      ),
    );
    const distillLever = distill.locator('.machine-lever');
    await build(() => distillLever.click());
    await completed(braneId, 1);
    // Brief comes from the Workshop and is fed from Distill by name: Distill may be out
    // of sight.
    const brief = await takeOut(page, build, state, braneId, 'Brief');
    const briefPlacement = (await brief.getAttribute('data-id'))!;
    await build(() =>
      brief.getByRole('button', { name: 'Feed material from another machine' }).click(),
    );
    await build(() => brief.getByRole('button', { name: 'Distill', exact: true }).click());
    await expect(brief.locator('[data-feed-slot="material"] .slot-chip')).toHaveCount(1);
    // The feed is drawn from Distill itself, not from its answer.
    await expect(
      page.getByRole('img', { name: `Edge from ${distillPlacement} to ${briefPlacement}` }),
    ).toHaveCount(1);
    const briefLever = brief.locator('.machine-lever');
    await expect(briefLever).toHaveText(/^Run/);
    await build(() => briefLever.click());
    await completed(braneId, 2);
    await expect(brief.locator('.machine-state')).toHaveText('ran');
    // Distill is offered nothing that would close a loop, and a drawn loop is refused.
    await expect(
      distill.getByRole('button', { name: 'Feed material from another machine' }),
    ).toHaveCount(0);
    await page.locator('.react-flow__controls-fitview').click();
    await drag(
      page,
      `.react-flow__node[data-id="${briefPlacement}"] .card-port`,
      distill.locator('[data-feed-slot="material"]'),
    );
    await expect(page.getByRole('alert')).toContainText('would close a loop');
    await expect(distill.locator('[data-feed-slot="material"] .slot-chip')).toHaveCount(1);
    await page.getByRole('alert').getByRole('button').first().click();

    // An edit upstream: Distill goes stale and Brief waits on it; one press reruns both.
    const editor = page
      .locator(`.react-flow__node[data-id="${cards[0].placementId}"]`)
      .getByRole('textbox', { name: 'Block text' });
    await act('update', () =>
      editor.fill(`${sources[0]} Land sales show the rise began at announcement.`),
    );
    await expect(distill.locator('.machine-state')).toHaveText('stale · material changed');
    await expect(brief.locator('.machine-state')).toHaveText('ran · waiting on Distill');
    await expect(briefLever).toHaveText(/^Rerun the chain ×2/);
    await expect(brief.getByRole('button', { name: 'Run this one only' })).toBeVisible();
    await act('update', () => briefLever.click());
    await completed(braneId, 4);
    await expect(distill.locator('.machine-state')).toHaveText('ran');
    await expect(brief.locator('.machine-state')).toHaveText('ran');
    // Distill answered before Brief was pressed, and Brief read that answer.
    const read = await state(braneId);
    const machineOf = (placementId: string) =>
      read.placements.find((p) => p.id === placementId)!.block_id;
    const distillRuns = read.runs.filter((r) => r.machine_block_id === machineOf(distillPlacement));
    const briefRuns = read.runs.filter((r) => r.machine_block_id === machineOf(briefPlacement));
    expect(briefRuns.at(-1)!.created_at).toBeGreaterThan(distillRuns.at(-1)!.created_at);
    const feeds = read.feeds.filter((f) => f.to_placement_id === briefPlacement);
    expect(
      feeds.map((f) => read.placements.find((p) => p.id === f.from_placement_id)?.block_id),
    ).toEqual([distillRuns.at(-1)!.output_block_id]);
    await page.screenshot({ path: 'test-results/machine-chain.png' });

    // Keep Brief current: its back lists the chain behind its answer, and after an edit
    // upstream the header offers one press for everything due.
    await act('keep', () => brief.getByRole('button', { name: 'Show back' }).click());
    const chainList = brief.getByRole('region', { name: 'Chain' });
    await expect(chainList.locator('li')).toHaveCount(3);
    await expect(chainList.locator('li').first()).toContainText('Distill');
    await expect(chainList.locator('li').last()).toContainText('Total');
    const keep = brief.getByRole('checkbox', { name: /Keep current/ });
    await act('keep', () => keep.click());
    await expect(keep).toBeChecked();
    await act('keep', () => brief.getByRole('button', { name: 'Show front' }).click());
    await act('keep', () =>
      editor.fill(`${sources[0]} Prices near stations fell back after a decade.`),
    );
    await expect(brief.locator('.machine-state')).toHaveText('due · waiting on Distill');
    const due = page.locator('.due-run');
    await expect(due).toHaveText(/^Run all due ×2/);
    await act('keep', () => due.click());
    await completed(braneId, 6);
    await expect(due).toHaveCount(0);
    await expect(brief.locator('.machine-state')).toHaveText('ran');

    // On a 320-pixel phone the same chain reruns from Brief.
    await editor.fill(`${sources[0]} The rise held for five years.`);
    await expect(brief.locator('.machine-state')).toHaveText('due · waiting on Distill');
    await page.setViewportSize({ width: 320, height: 740 });
    // A phone opens the brane in Focus; Brief is chosen from the strip.
    await page.getByRole('button', { name: /^\d+ Write a brief from/ }).click();
    const lever = page.locator('.machine-lever');
    await expect(lever).toHaveText(/^Rerun the chain ×2/);
    await expect(
      page.getByRole('button', { name: 'Feed material from another machine' }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.screenshot({ path: 'test-results/machine-chain-phone.png' });
    await lever.click();
    await completed(braneId, 8);
    await expect(lever).toHaveText(/^Run/);
  });
  record('chain', counts);
});

test('on a 320-pixel phone a chain is built and run in Focus with Feed into…', async ({ page }) => {
  const counts = { actions: 0 };
  await page.setViewportSize({ width: 320, height: 740 });
  await serve(page, 4211, async ({ seed, completed, state, api, origin }) => {
    const { braneId, cards } = await seed('Phone chain', sources);
    // Two machines already on the brane: Distill fed the sources, and a Brief unfed.
    const place = async (template: string, y: number) => {
      const block = await (
        await page.request.post(api('/blocks/machine'), {
          data: { braneId, geometry: { x: 900, y, width: 400, height: 300 }, template },
        })
      ).json();
      return (await state(braneId)).placements.find((p) => p.block_id === block.id)!.id;
    };
    const distill = await place('Distill {material} into one card.', 0);
    const brief = await place('Write a brief from {material}.', 400);
    for (const card of cards)
      await page.request.post(api('/feeds'), {
        data: {
          braneId,
          fromPlacementId: card.placementId,
          toPlacementId: distill,
          slot: 'material',
        },
      });
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    const strip = (name: RegExp) => page.getByRole('button', { name });
    const lever = page.locator('.machine-lever');
    await act(() => strip(/^\d+ Distill \{material\}/).click());
    await act(() => lever.click());
    await completed(braneId, 1);
    await act(() =>
      page
        .getByRole('button', { name: 'Feed this machine’s answers into another machine' })
        .click(),
    );
    await act(() => page.getByRole('button', { name: 'Write a brief from · material' }).click());
    await expect
      .poll(async () => (await state(braneId)).feeds.filter((f) => f.to_placement_id === brief))
      .toHaveLength(1);
    await act(() => strip(/^\d+ Write a brief from/).click());
    await expect(page.locator('.slot-chip')).toHaveCount(1);
    await act(() => lever.click());
    await completed(braneId, 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.screenshot({ path: 'test-results/machine-phone-feed-into.png' });
  });
  record('phone-chain', counts);
});

test('a machine’s prompt is tuned: its answer goes stale, reruns, and keeps the earlier one', async ({
  page,
}) => {
  const counts = { actions: 0, typed: 0 };
  await serve(page, 4212, async ({ seed, completed, state, api, origin }) => {
    const { braneId, cards } = await seed('Tune', sources.slice(0, 1));
    const block = await (
      await page.request.post(api('/blocks/machine'), {
        data: {
          braneId,
          geometry: { x: 420, y: 40, width: 400, height: 300 },
          template: 'Summarise {source} in one sentence.',
        },
      })
    ).json();
    const machine = (await state(braneId)).placements.find((p) => p.block_id === block.id)!.id;
    await page.request.post(api('/feeds'), {
      data: {
        braneId,
        fromPlacementId: cards[0].placementId,
        toPlacementId: machine,
        slot: 'source',
      },
    });
    await page.goto(`${origin}/b/${braneId}`);
    const node = page.locator(`.react-flow__node[data-id="${machine}"]`);
    const lever = node.locator('.machine-lever');
    await lever.click();
    await completed(braneId, 1);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    // Tune the prompt: the machine reads stale, and one press reruns it.
    const prompt = 'Summarise {source} in one sentence for a council member.';
    counts.typed += prompt.length;
    await act(() => node.getByRole('textbox', { name: 'Machine prompt' }).fill(prompt));
    await expect(node.locator('.machine-state')).toHaveText('stale · prompt edited');
    await expect(lever).toHaveText(/^Rerun/);
    await act(() => lever.click());
    await completed(braneId, 2);
    const read = await state(braneId);
    const [first, second] = read.runs;
    const versions = [first, second].map(
      (run) => (run as unknown as { machine_version: number }).machine_version,
    );
    expect(versions[1]).toBeGreaterThan(versions[0]);
    const answer = page.locator(
      `.react-flow__node[data-id="${read.placements.find((p) => p.block_id === second.output_block_id)!.id}"]`,
    );
    await act(() => answer.getByRole('button', { name: /^Show back/ }).click());
    await expect(answer.getByRole('region', { name: 'Receipt' })).toContainText(
      `prompt version ${versions[1]}`,
    );
    await expect(answer.locator('.back-item')).toContainText(
      `Earlier version · prompt version ${versions[0]}`,
    );
  });
  record('tune', counts);
});

// At scale: what the page costs in frames, requests and time once a table holds dozens
// of answers. Recorded, not asserted beyond what must hold.
async function panFrames(page: Page) {
  const pane = page.locator('.react-flow__pane');
  const box = (await pane.boundingBox())!;
  await page.evaluate(() => {
    const frames: number[] = [];
    (window as unknown as { frames_: number[] }).frames_ = frames;
    const tick = (time: number) => {
      frames.push(time);
      if (frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down('Space');
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4, { steps: 60 });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 60 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const frames = await page.evaluate(() => (window as unknown as { frames_: number[] }).frames_);
  const gaps = frames
    .slice(1)
    .map((time, index) => time - frames[index])
    .sort((a, b) => a - b);
  return {
    frames: gaps.length,
    medianMs: Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10,
    p95Ms: Math.round(gaps[Math.floor(gaps.length * 0.95)] * 10) / 10,
    maxMs: Math.round(gaps.at(-1)! * 10) / 10,
  };
}
function countRequests(page: Page) {
  const times: number[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) times.push(Date.now());
  });
  // The most requests the page made in any one minute so far.
  return () =>
    times.reduce(
      (most, time, index) =>
        Math.max(most, times.slice(index).filter((later) => later - time < 60_000).length),
      0,
    );
}

test('at scale: twelve papers through Split each and Diagram', async ({ page }) => {
  test.slow();
  const counts = { actions: 0, splitMs: 0, diagramMs: 0, ideas: 0, requestsPerMinute: 0 };
  let pan: Awaited<ReturnType<typeof panFrames>> | undefined;
  await serve(page, 4213, async ({ seed, completed, state, origin }) => {
    const requests = countRequests(page);
    const papers = Array.from(
      { length: 12 },
      (_, i) => `Paper ${i + 1} finds that sleep helps memory. Its effect holds for naps.`,
    );
    const { braneId, cards } = await seed('Scale pile', papers, grid);
    counts.actions++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    const split = await takeOut(page, act, state, braneId, 'Split');
    await page.locator('.react-flow__controls-fitview').click();
    await act(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"]:has([aria-label="Group 1"]) .card-port',
        split.locator('[data-feed-slot="text"]'),
      ),
    );
    await act(() => split.getByRole('button', { name: /one card at a time/ }).click());
    await expect(split.locator('.machine-lever')).toHaveText(/^Run ×12/);
    let started = Date.now();
    await act(() => split.locator('.machine-lever').click());
    await completed(braneId, 12);
    const ideas = page.locator('[aria-roledescription="group"][aria-label="Each text"]');
    await expect(ideas).toContainText('Stack · 24');
    counts.splitMs = Date.now() - started;
    counts.ideas = 24;
    const diagram = await takeOut(page, act, state, braneId, 'Diagram');
    await page.locator('.react-flow__controls-fitview').click();
    await act(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"]:has([aria-label="Each text"]) .card-port',
        diagram.locator('[data-feed-slot="material"]'),
      ),
    );
    started = Date.now();
    await act(() => diagram.locator('.machine-lever').click());
    await completed(braneId, 13);
    await expect(
      page.locator('[aria-roledescription="group"][aria-label="Diagram"]'),
    ).toBeVisible();
    counts.diagramMs = Date.now() - started;
    await page.locator('.react-flow__controls-fitview').click();
    pan = await panFrames(page);
    counts.requestsPerMinute = requests();
    expect(counts.requestsPerMinute).toBeLessThan(240);
  });
  record('scale-pile', { ...counts, pan });
});

test('at scale: twelve papers and five questions make a sixty-cell matrix', async ({ page }) => {
  test.slow();
  const counts = {
    actions: 0,
    typed: 0,
    pressMs: [] as number[],
    matrixMs: 0,
    requestsPerMinute: 0,
  };
  let pan: Awaited<ReturnType<typeof panFrames>> | undefined;
  const questions = [
    'what method it uses',
    'its sample size',
    'its main finding',
    'where it was done',
    'what it leaves open',
  ];
  await serve(page, 4214, async ({ seed, completed, state, origin }) => {
    const requests = countRequests(page);
    const papers = Array.from({ length: 12 }, (_, i) => `Paper ${i + 1}: survey of 40 cities.`);
    const { braneId, cards } = await seed('Scale matrix', papers, grid);
    counts.actions++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    let previous: Locator | undefined;
    for (const [index, question] of questions.entries()) {
      const prompt = `From {source}, answer in one short sentence: ${question}?`;
      counts.typed += prompt.length;
      let extract: Locator;
      if (!previous) {
        extract = await takeOut(page, act, state, braneId, 'Extract');
        await act(() => extract.getByRole('textbox', { name: 'Machine prompt' }).fill(prompt));
        await page.locator('.react-flow__controls-fitview').click();
        await act(() =>
          drag(
            page,
            '.react-flow__node[data-id^="group:"]:has([aria-label="Group 1"]) .card-port',
            extract.locator('[data-feed-slot="source"]'),
          ),
        );
        await act(() => extract.getByRole('button', { name: /one card at a time/ }).click());
      } else {
        extract = await duplicate(page, act, state, braneId, previous);
        await act(() => extract.getByRole('textbox', { name: 'Machine prompt' }).fill(prompt));
      }
      previous = extract;
      await expect(extract.locator('.machine-lever')).toHaveText(/^Run ×12/);
      const started = Date.now();
      await act(() => extract.locator('.machine-lever').click());
      await completed(braneId, 12 * (index + 1));
      counts.pressMs.push(Date.now() - started);
    }
    const read = await state(braneId);
    await page.locator('.react-flow__controls-fitview').click();
    const outputs = read.runs.map((run) => ({
      placementId: read.placements.find((p) => p.block_id === run.output_block_id)!.id,
    }));
    await act(() => lasso(page, outputs, 'below'));
    await act(() => page.keyboard.press('g'));
    const started = Date.now();
    await act(() => page.getByRole('button', { name: 'Matrix', exact: true }).click());
    const matrix = page.locator('[aria-roledescription="group"]').filter({ hasText: '12 × 5' });
    await expect(matrix.getByRole('rowheader')).toHaveCount(12);
    counts.matrixMs = Date.now() - started;
    await page.locator('.react-flow__controls-fitview').click();
    pan = await panFrames(page);
    counts.requestsPerMinute = requests();
    // Laying out the matrix saves every card's place in one request, not one each.
    expect(counts.requestsPerMinute).toBeLessThan(120);
  });
  record('scale-matrix', { ...counts, pan });
});

test('a reading pile splits into ideas each, and the ideas become a diagram', async ({ page }) => {
  const counts = { actions: 0 };
  await serve(page, 4208, async ({ seed, completed, state, origin }) => {
    const papers = [1, 2, 3].map(
      (n) => `Paper ${n} finds that sleep helps memory. Its effect holds for naps.`,
    );
    const { braneId, cards } = await seed('Pile to diagram', papers, grid);
    counts.actions++; // the drop
    await page.goto(`${origin}/b/${braneId}`);
    const act = async (work: () => Promise<unknown>) => {
      counts.actions++;
      await work();
    };
    await act(() => lasso(page, cards));
    await act(() => page.keyboard.press('g'));
    await act(() => page.getByRole('button', { name: 'Stack', exact: true }).click());
    const split = await takeOut(page, act, state, braneId, 'Split');
    await page.locator('.react-flow__controls-fitview').click();
    await act(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"]:has([aria-label="Group 1"]) .card-port',
        split.locator('[data-feed-slot="text"]'),
      ),
    );
    await act(() => split.getByRole('button', { name: /one card at a time/ }).click());
    await expect(split.locator('.machine-lever')).toHaveText(/^Run ×3/);
    await act(() => split.locator('.machine-lever').click());
    await completed(braneId, 3);
    // Every paper's answer became its two ideas, in the stack the press made.
    const ideas = page.locator('[aria-roledescription="group"][aria-label="Each text"]');
    await expect(ideas).toContainText('Stack · 6');
    const diagram = await takeOut(page, act, state, braneId, 'Diagram');
    await page.locator('.react-flow__controls-fitview').click();
    await act(() =>
      drag(
        page,
        '.react-flow__node[data-id^="group:"]:has([aria-label="Each text"]) .card-port',
        diagram.locator('[data-feed-slot="material"]'),
      ),
    );
    await act(() => diagram.locator('.machine-lever').click());
    await completed(braneId, 4);
    const region = page.locator('[aria-roledescription="group"][aria-label="Diagram"]');
    await expect(region).toContainText('6 cards');
    let read = await state(braneId);
    const map = read.groups.find((g) => g.label === 'Diagram')!;
    expect(read.relations.filter((r) => map.members.includes(r.from_placement_id))).toHaveLength(5);
    await expect(page.locator('.relation-word', { hasText: 'supports' })).toHaveCount(5);
    // Rearrange it: it is now the user's diagram.
    await page.locator('.react-flow__controls-fitview').click();
    const moved = map.members[1];
    const before = read.placements.find((p) => p.id === moved)!;
    const card = page.locator(`.react-flow__node[data-id="${moved}"]`);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const box = (await card.boundingBox())!;
    await act(async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + 12);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + 80, { steps: 8 });
      await page.mouse.up();
    });
    await expect
      .poll(async () => {
        read = await state(braneId);
        return read.placements.find((p) => p.id === moved)!.x;
      })
      .toBeGreaterThan(before.x);
  });
  record('pile-diagram', counts);
});

// Duplicate a machine with its feeds: its menu, then Duplicate. Returns the copy's node.
async function duplicate(
  page: Page,
  act: (work: () => Promise<unknown>) => Promise<void>,
  state: Server['state'],
  braneId: string,
  machine: Locator,
) {
  const before = new Set(
    (await state(braneId)).blocks.filter((b) => b.kind === 'machine').map((b) => b.id),
  );
  await act(() => machine.getByRole('button', { name: 'Machine actions' }).click());
  await act(() => machine.getByRole('button', { name: 'Duplicate with feeds' }).click());
  let placementId = '';
  await expect
    .poll(
      async () => {
        const read = await state(braneId);
        const block = read.blocks.find((b) => b.kind === 'machine' && !before.has(b.id));
        placementId = read.placements.find((p) => p.block_id === block?.id)?.id ?? '';
        return placementId;
      },
      { intervals: [250, 500] },
    )
    .not.toBe('');
  return page.locator(`.react-flow__node[data-id="${placementId}"]`);
}
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
    .poll(
      async () => {
        const read = await state(braneId);
        const block = read.blocks.find((b) => b.kind === 'machine' && !before.has(b.id));
        placementId = read.placements.find((p) => p.block_id === block?.id)?.id ?? '';
        return placementId;
      },
      { intervals: [250, 500] },
    )
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

// One marquee across a grid of cards, from the empty table beyond its right edge: from
// above its top, or from below its bottom up to just inside its top.
async function lasso(
  page: Page,
  cards: { placementId: string }[],
  from: 'above' | 'below' = 'above',
) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
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
  await page.mouse.move(right + 40, from === 'above' ? top - 10 : bottom + 10);
  await page.mouse.down();
  await page.mouse.move(left + 20, from === 'above' ? bottom - 20 : top + 20, { steps: 10 });
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
  feeds: { to_placement_id: string; from_placement_id: string | null }[];
  runs: {
    id: string;
    created_at: number;
    model: string;
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
      MODEL_ALLOWLIST: 'mock,mock-brief',
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
            // A refused read (the account's request limit) counts as not yet.
            async () =>
              (await state(braneId)).runs?.filter((r) => r.status === 'completed').length ?? -1,
            { timeout: 30_000, intervals: [500, 1000] },
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
  // A fitted view animates; both ends are read once they have held still for three
  // reads in a row.
  let start = await page.locator(from).boundingBox();
  let end = await to.boundingBox();
  for (let attempt = 0, still = 0; attempt < 40 && still < 3; attempt++) {
    await page.waitForTimeout(100);
    const nextStart = await page.locator(from).boundingBox();
    const nextEnd = await to.boundingBox();
    still = JSON.stringify([nextStart, nextEnd]) === JSON.stringify([start, end]) ? still + 1 : 0;
    start = nextStart;
    end = nextEnd;
  }
  if (!start || !end) throw new Error('Feed endpoints are not visible');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}
