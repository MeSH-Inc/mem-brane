// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { pasteFiles, transferFiles, dropFiles } from '../src/services/import-adapters';
function transfer(files: File[], text = '') {
  return {
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    files,
    getData: () => text,
  } as unknown as DataTransfer;
}
function event(target: HTMLElement, clipboardData: DataTransfer) {
  return {
    target,
    clipboardData,
    dataTransfer: clipboardData,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
it('preserves native text paste, including mixed text and image clipboard data', () => {
  const editor = document.createElement('textarea'),
    accept = vi.fn();
  const plain = event(editor, transfer([], 'selected text'));
  pasteFiles(plain as any, accept);
  expect(plain.preventDefault).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
  const mixed = event(editor, transfer([new File(['png'], 'clip.png')], 'caption'));
  pasteFiles(mixed as any, accept);
  expect(mixed.preventDefault).not.toHaveBeenCalled();
  expect(mixed.stopPropagation).toHaveBeenCalledOnce();
  expect(accept).toHaveBeenCalledOnce();
});
it('takes one view of file data and consumes image-only paste/drop without browser navigation', () => {
  const file = new File(['png'], 'clip.png'),
    data = transfer([file]);
  expect(transferFiles(data)).toEqual([file]);
  const pasted = event(document.createElement('textarea'), data),
    accept = vi.fn();
  pasteFiles(pasted as any, accept);
  expect(pasted.preventDefault).toHaveBeenCalledOnce();
  const dropped = event(document.createElement('div'), data);
  dropFiles(dropped as any, accept);
  expect(dropped.preventDefault).toHaveBeenCalledOnce();
  expect(accept).toHaveBeenCalledTimes(2);
});
