export interface WorkspaceDraft {
  prompt?: string;
  model?: string;
  title?: string;
  references?: string[];
  continueFrom?: string;
}
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

// One authoritative composer per actor/brane, persisted within the browser tab.
export class WorkspaceDrafts {
  draft: WorkspaceDraft = {};
  error = '';
  private key: string;
  constructor(
    actor: string | undefined,
    braneId: string,
    private storage: WorkspaceStorage,
  ) {
    this.key = JSON.stringify(['mem-brane-workspace-draft', 1, actor, braneId]);
    try {
      const value = JSON.parse(storage.getItem(this.key) ?? '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const field of ['prompt', 'model', 'title', 'continueFrom'])
        if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error();
      if (
        value.references !== undefined &&
        (!Array.isArray(value.references) ||
          value.references.some((id: unknown) => typeof id !== 'string'))
      )
        throw new Error();
      this.draft = value;
    } catch {
      this.error =
        'Workspace draft recovery is unavailable. Keep this tab open until work is saved.';
    }
  }
  update(patch: Partial<WorkspaceDraft>) {
    this.draft = { ...this.draft, ...patch };
    try {
      this.storage.setItem(this.key, JSON.stringify(this.draft));
    } catch {
      this.error =
        'Could not preserve this workspace draft. Keep this tab open until work is saved.';
    }
  }
}
