import type { DB } from '../db/index.js';
import type { Placement } from '../../shared/types/domain.js';
import { machineName } from '../../shared/machines.js';
import { MAX_GROUP_MEMBERS } from '../../shared/groups.js';
import { machineOutput, parseOutput } from '../../shared/machine-output.js';
import { DomainError } from '../domain/access.js';
import { createBlock, now, uid } from './content.js';
import { moveToBack } from './runs.js';
import { MAX_BRANE_GROUPS } from './groups.js';

const STACK_OFFSET = 10;
const REGION_GAP = 40;

// A completed machine run whose prompt declares "Output: cards" or "Output: diagram"
// places one card per numbered item where its output lay on the table. The whole answer
// goes on the first card's back, with whatever was on its own back. If the output was in
// a group the cards take its place there, in order; otherwise they arrive as a stack of
// cards or a region of the diagram, with its arrows drawn. An answer of fewer than two
// items, an output no longer on the table, or a brane without room keeps its one card.
// Runs inside the completion's transaction; nothing it refuses fails the run.
export function placeRunParts(db: DB, runId: string, text: string) {
  const run = db
    .prepare<unknown[], { owner_id: string; brane_id: string; template: string }>(
      `SELECT r.owner_id,r.brane_id,json_extract(v.content_json,'$.text') template FROM runs r
       JOIN context_entries e ON e.context_id=r.context_id AND e.kind='prompt'
       JOIN block_revisions v ON v.id=e.revision_id JOIN blocks b ON b.id=v.block_id
       WHERE r.id=? AND b.kind='machine'`,
    )
    .get(runId);
  if (!run) return;
  const output = machineOutput(run.template);
  if (output === 'card') return;
  const parts = parseOutput(text, output);
  if (parts.items.length < 2) return;
  const placed = db
    .prepare<unknown[], Placement>(
      `SELECT p.* FROM run_placements l JOIN placements p ON p.id=l.output_placement_id
       WHERE l.run_id=? AND p.host_placement_id IS NULL`,
    )
    .get(runId);
  if (!placed) return;
  const membership = db
    .prepare<unknown[], { group_id: string; position: number; display: string; size: number }>(
      `SELECT m.group_id,m.position,g.display,
       (SELECT count(*) FROM group_members WHERE group_id=m.group_id) size
       FROM group_members m JOIN groups g ON g.id=m.group_id WHERE m.placement_id=?`,
    )
    .get(placed.id);
  if (membership && membership.size - 1 + parts.items.length > MAX_GROUP_MEMBERS) return;
  if (
    !membership &&
    (
      db.prepare('SELECT count(*) n FROM groups WHERE brane_id=?').get(run.brane_id) as {
        n: number;
      }
    ).n >= MAX_BRANE_GROUPS
  )
    return;
  // A diagram spreads on a grid unless it joins a stack; cards pile as a stack does.
  const spread = output === 'diagram' && membership?.display !== 'stack';
  const columns = Math.ceil(Math.sqrt(parts.items.length));
  const geometry = (index: number) =>
    spread
      ? {
          x: placed.x + (index % columns) * (placed.width + REGION_GAP),
          y: placed.y + Math.floor(index / columns) * (placed.height + REGION_GAP),
          width: placed.width,
          height: placed.height,
        }
      : {
          x: placed.x + Math.min(index, 3) * STACK_OFFSET,
          y: placed.y + Math.min(index, 3) * STACK_OFFSET,
          width: placed.width,
          height: placed.height,
        };
  const time = now();
  try {
    db.transaction(() => {
      const cards = parts.items.map((item, position) => {
        const content = { format: 'text' as const, text: item };
        const block = createBlock(
          db,
          run.owner_id,
          'text',
          content,
          run.brane_id,
          geometry(position),
          'generated',
        );
        const revisionId = uid();
        db.prepare(
          'INSERT INTO block_revisions (id,block_id,content_json,created_at) VALUES (?,?,?,?)',
        ).run(revisionId, block.id, JSON.stringify(content), time);
        db.prepare('INSERT INTO run_parts VALUES (?,?,?,?)').run(
          runId,
          position,
          block.id,
          revisionId,
        );
        return block.placement.id;
      });
      // The first card takes the output's place: its group position, feeds and arrows.
      moveToBack(db, placed, cards[0]);
      if (membership) {
        db.prepare(
          'UPDATE group_members SET position=position+? WHERE group_id=? AND position>?',
        ).run(cards.length - 1, membership.group_id, membership.position);
        const add = db.prepare('INSERT INTO group_members VALUES (?,?,?)');
        cards
          .slice(1)
          .forEach((card, index) =>
            add.run(membership.group_id, card, membership.position + index + 1),
          );
      } else {
        const groupId = uid();
        db.prepare('INSERT INTO groups VALUES (?,?,?,?,?)').run(
          groupId,
          run.brane_id,
          machineName(run.template) || 'Output',
          output === 'diagram' ? 'region' : 'stack',
          time,
        );
        const add = db.prepare('INSERT INTO group_members VALUES (?,?,?)');
        cards.forEach((card, position) => add.run(groupId, card, position));
      }
      const relate = db.prepare('INSERT INTO relations VALUES (?,?,?,?,?,?)');
      for (const arrow of parts.arrows)
        relate.run(uid(), run.brane_id, cards[arrow.from], cards[arrow.to], arrow.label, time);
    })();
  } catch (error) {
    // A brane or library at capacity keeps the answer as one card.
    if (!(error instanceof DomainError)) throw error;
  }
}
