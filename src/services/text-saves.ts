import type { Block, BraneState, Edit } from '../../shared/types/domain';
import type { SavedText } from '../../shared/contracts';
export type { SavedText } from '../../shared/contracts';
// Reserve all affected entity lanes synchronously. Only overlapping commands
// wait; a multi-source snapshot forms a barrier for subsequent source edits.
export class TextSaves {
  private accepted = new Map<string, SavedText>();
  private ownVersions = new Map<string, Map<number, number>>();
  private lanes = new Map<string, Promise<unknown>>();
  private pending = new Set<Promise<unknown>>();
  constructor(private write: (edit: Edit) => Promise<SavedText>) {}
  serialize<T>(ids: string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(ids)];
    const before = [...new Set(keys.map((id) => this.lanes.get(id)).filter(Boolean))];
    const result = Promise.all(before.map((p) => p!.catch(() => {}))).then(work);
    for (const id of keys) this.lanes.set(id, result);
    this.pending.add(result);
    const cleanup = () => {
      this.pending.delete(result);
      for (const id of keys) if (this.lanes.get(id) === result) this.lanes.delete(id);
    };
    void result.then(cleanup, cleanup);
    return result;
  }
  flush() {
    return Promise.all([...this.pending]).then(() => {});
  }
  acknowledge(id: string, saved: SavedText, expectedVersion?: number) {
    const previous = this.accepted.get(id);
    if (!previous || saved.version > previous.version) this.accepted.set(id, saved);
    if (expectedVersion !== undefined && saved.version === expectedVersion + 1) {
      let versions = this.ownVersions.get(id);
      if (!versions) {
        versions = new Map();
        this.ownVersions.set(id, versions);
      }
      versions.set(expectedVersion, saved.version);
    }
  }
  // Advance only through this controller's receipts. Observing another writer's
  // newer version never authorizes silently rebasing the captured intent.
  afterOwnWrites(edit: Edit): Edit {
    let version = edit.version;
    const versions = this.ownVersions.get(edit.blockId);
    while (versions?.has(version)) version = versions.get(version)!;
    return version === edit.version ? edit : { ...edit, version };
  }
  async save(edit: Edit) {
    const saved = await this.write(edit);
    this.acknowledge(edit.blockId, saved, edit.version);
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
