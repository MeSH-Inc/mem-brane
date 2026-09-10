import { expect, it } from 'vitest';
import { createPresentation } from '../src/stores/presentation';
it('retains camera, focus and placement selection independently of attention requests', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const p = createPresentation(storage);
  p.getState().remember({
    viewport: { x: -300, y: 20, zoom: 0.5 },
    focus: 'block',
    selection: ['copy2'],
  });
  p.getState().reveal(0, { blockId: 'block', kind: 'edit' });
  const recovered = createPresentation(storage).getState();
  expect(recovered.viewport).toEqual({ x: -300, y: 20, zoom: 0.5 });
  expect(recovered.focus).toBe('block');
  expect(recovered.selection).toEqual(['copy2']);
  expect(recovered.request).toBeUndefined();
});
it('ignores old completions and consumes each attention request once', () => {
  const p = createPresentation();
  const first = p.getState().attention;
  p.getState().interact();
  expect(p.getState().reveal(first, { blockId: 'old', kind: 'reveal' })).toBe(false);
  expect(p.getState().reveal(p.getState().attention, { blockId: 'new', kind: 'edit' })).toBe(true);
  const id = p.getState().request!.id;
  p.getState().consume('old');
  expect(p.getState().request?.id).toBe(id);
  p.getState().consume(id);
  expect(p.getState().request).toBeUndefined();
});
