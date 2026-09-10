import type { Block, BraneState, Edit } from '../../shared/types/domain';

import type { SavedText } from '../../shared/contracts';
export type { SavedText } from '../../shared/contracts';
// This service owns acknowledged text versions and orders text writes with snapshot submissions.
export class TextSaves {
  private accepted = new Map<string, SavedText>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private write: (edit: Edit) => Promise<SavedText>) {}
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(work);
    this.tail = result;
    return result;
  }
  flush() {
    return this.tail;
  }
  acknowledge(id: string, saved: SavedText) {
    const previous = this.accepted.get(id);
    if (!previous || saved.version > previous.version) this.accepted.set(id, saved);
  }
  async save(edit: Edit) {
    const saved = await this.write(edit);
    this.acknowledge(edit.blockId, saved);
    return saved;
  }
  reconcile(state: BraneState): BraneState {
    return { ...state, blocks: state.blocks.map((block) => this.reconcileBlock(block)) };
  }
  private reconcileBlock(block: Block): Block {
    if (
      block.origin !== 'authored' ||
      (block.content.format !== 'text' && block.content.format !== 'webpage')
    )
      return block;
    this.acknowledge(block.id, { version: block.version, content: block.content });
    const saved = this.accepted.get(block.id)!;
    return saved.version > block.version ? { ...block, ...saved } : block;
  }
}
