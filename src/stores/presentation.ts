import { createStore } from 'zustand/vanilla';
import { defaultViewport, type Viewport } from '../canvas/gestures';
export type AttentionRequest = {
  id: string;
  blockId: string;
  placementId?: string;
  kind: 'edit' | 'reveal';
};
export interface Presentation {
  viewport: Viewport;
  focus?: string;
  selection: string[];
  attention: number;
  request?: AttentionRequest;
  interact(): void;
  remember(patch: Partial<Pick<Presentation, 'viewport' | 'focus' | 'selection'>>): void;
  reveal(attention: number, request: Omit<AttentionRequest, 'id'>): boolean;
  consume(id: string): void;
}
export function createPresentation(
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
  key = 'presentation',
) {
  let saved: Partial<Pick<Presentation, 'viewport' | 'focus' | 'selection'>> = {};
  try {
    const value = JSON.parse(storage?.getItem(key) ?? '{}');
    if (
      value.viewport &&
      ['x', 'y', 'zoom'].every((k) => Number.isFinite(value.viewport[k])) &&
      value.viewport.zoom >= 0.2 &&
      value.viewport.zoom <= 2
    )
      saved.viewport = value.viewport;
    if (typeof value.focus === 'string') saved.focus = value.focus;
    if (
      Array.isArray(value.selection) &&
      value.selection.every((id: unknown) => typeof id === 'string')
    )
      saved.selection = value.selection;
  } catch {
    /* Camera recovery is optional; document durability is independent. */
  }
  return createStore<Presentation>((set, get) => ({
    viewport: defaultViewport,
    selection: [],
    ...saved,
    attention: 0,
    interact: () => set((s) => ({ attention: s.attention + 1, request: undefined })),
    remember: (patch) => {
      const previous = get();
      if (
        Object.entries(patch).every(([key, value]) =>
          key === 'viewport'
            ? value &&
              previous.viewport.x === (value as Viewport).x &&
              previous.viewport.y === (value as Viewport).y &&
              previous.viewport.zoom === (value as Viewport).zoom
            : previous[key as 'focus' | 'selection'] === value,
        )
      )
        return;
      set(patch);
      const { viewport, focus, selection } = get();
      try {
        storage?.setItem(key, JSON.stringify({ viewport, focus, selection }));
      } catch {
        /* Do not interrupt gestures for optional presentation storage. */
      }
    },
    reveal: (attention, request) => {
      if (get().attention !== attention) return false;
      set({ request: { ...request, id: crypto.randomUUID() } });
      return true;
    },
    consume: (id) => {
      if (get().request?.id === id) set({ request: undefined });
    },
  }));
}
const presentations = new Map<string, ReturnType<typeof createPresentation>>();
export function presentationFor(actor: string | undefined, braneId: string) {
  const key = JSON.stringify(['mem-brane-presentation', actor, braneId]);
  let store = presentations.get(key);
  if (!store) {
    let storage: Storage | undefined;
    try {
      storage = sessionStorage;
    } catch {
      /* Rendering also works without browser storage. */
    }
    store = createPresentation(storage, key);
    presentations.set(key, store);
  }
  return store;
}
