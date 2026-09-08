import { useRef, useState } from 'react';

export interface WorkspaceDraft {
  prompt?: string;
  model?: string;
  title?: string;
  references?: string[];
  continueFrom?: string;
}

// sessionStorage survives reload/navigation and is isolated per browser tab.
// A duplicated tab starts with a copy, then evolves independently.
// The owner must remount with a new key when actor or brane changes.
export function useWorkspaceDraft(actor: string | undefined, braneId: string) {
  const key = JSON.stringify(['mem-brane-workspace-draft', 1, actor, braneId]);
  const [error, setError] = useState('');
  const [draft, render] = useState<WorkspaceDraft>(() => {
    if (!actor) return {};
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid draft');
      for (const field of ['prompt', 'model', 'title', 'continueFrom'])
        if (value[field] !== undefined && typeof value[field] !== 'string')
          throw new Error('Invalid draft');
      if (
        value.references !== undefined &&
        (!Array.isArray(value.references) ||
          value.references.some((id: unknown) => typeof id !== 'string'))
      )
        throw new Error('Invalid references');
      return value;
    } catch {
      setError('Workspace draft recovery is unavailable. Keep this tab open until work is saved.');
      return {};
    }
  });
  const current = useRef(draft);
  function update(patch: Partial<WorkspaceDraft>) {
    current.current = { ...current.current, ...patch };
    render(current.current);
    if (!actor) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(current.current));
    } catch {
      setError('Could not preserve this workspace draft. Keep this tab open until work is saved.');
    }
  }
  return { draft, current, update, error };
}
