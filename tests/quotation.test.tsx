// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BlockContent } from '../src/components/BlockContent';
import { quotation } from '../src/services/workspace';
import { MAX_BLOCK_TEXT_CHARACTERS } from '../shared/limits';
import type { Block } from '../shared/types/domain';
let root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

const webpage: Block = {
  id: 'page',
  kind: 'webpage',
  origin: 'authored',
  version: 1,
  content: {
    format: 'webpage',
    text: 'Transit raises rents. Rents near stations rose ten percent. Few moved.',
    url: 'https://example.org/transit',
    status: 'ready',
  },
};

it('quotes a passage with the source it came from, within one card', () => {
  expect(quotation(webpage.content, { text: '  Rents near\n stations rose. ' })).toBe(
    '“Rents near stations rose.”\n\n— https://example.org/transit',
  );
  const pdf = {
    format: 'pdf' as const,
    text: '',
    filename: 'Research.pdf',
    assetId: 'asset',
    assetHash: 'hash',
    mimeType: 'application/pdf' as const,
    pageCount: 2,
    representationId: 'representation',
    representation: { kind: 'pdf-text-v1' as const, extractor: 'test', status: 'ready' as const },
  };
  expect(quotation(pdf, { text: 'Conclusion', page: 2 })).toBe(
    '“Conclusion”\n\n— Research.pdf, page 2',
  );
  // A passage longer than a card holds is cut, and the citation always stays.
  const long = quotation(pdf, { text: 'word '.repeat(MAX_BLOCK_TEXT_CHARACTERS) });
  expect(long.length).toBeLessThanOrEqual(MAX_BLOCK_TEXT_CHARACTERS);
  expect(long.endsWith('…”\n\n— Research.pdf')).toBe(true);
});

it('quotes the passage selected in a webpage card with Q, and types q with nothing selected', () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onQuote = vi.fn();
  act(() => root.render(<BlockContent block={webpage} onEdit={() => {}} onQuote={onQuote} />));
  const editor = host.querySelector('textarea')!;
  const press = () => {
    const event = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true });
    act(() => {
      editor.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  expect(press()).toBe(false);
  expect(host.querySelector('.quote-button')).toBeNull();
  const start = webpage.content.text.indexOf('Rents');
  // React reads a textarea's selection when it changes while the textarea has focus.
  act(() => {
    editor.focus();
    editor.setSelectionRange(start, start + 'Rents near stations rose ten percent.'.length);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(host.querySelector('.quote-button')?.textContent).toBe('❝ Quote');
  expect(press()).toBe(true);
  expect(onQuote).toHaveBeenCalledWith('page', { text: 'Rents near stations rose ten percent.' });
});
