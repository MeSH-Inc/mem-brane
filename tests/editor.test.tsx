// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BlockContent } from '../src/components/BlockContent';
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
});
it('keyboard input stays in the editor instead of reaching canvas shortcuts', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const outerKey = vi.fn();

  root = createRoot(host);
  act(() =>
    root!.render(
      <div onKeyDown={outerKey}>
        <BlockContent
          block={{
            id: 'block',
            kind: 'text',
            origin: 'authored',
            version: 0,
            content: { format: 'text', text: 'Editable' },
          }}
          onEdit={() => {}}
        />
      </div>,
    ),
  );
  const editor = host.querySelector('textarea')!;
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  expect(outerKey).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
  expect(editor.getAttribute('aria-label')).toBe('Block text');
});
