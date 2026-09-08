import type { ClipboardEvent, DragEvent } from 'react';

export const acceptedFiles = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
export function supportedFile(file: File) {
  return (
    /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(file.type) ||
    /\.(png|jpe?g|gif|webp|pdf)$/i.test(file.name)
  );
}
export function transferFiles(transfer: DataTransfer): File[] {
  // items and files are alternate views of the same files, not two batches.
  const items = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return items.length ? items : Array.from(transfer.files ?? []);
}
export function pasteFiles(event: ClipboardEvent, accept: (files: File[]) => void) {
  const files = transferFiles(event.clipboardData);
  if (!files.length) return;
  const target = event.target as HTMLElement;
  // Let the browser insert the plain-text portion at the selection in an editor.
  const editing = !!target.closest('textarea,input,[contenteditable="true"]');
  if (!editing || !event.clipboardData.getData('text/plain')) event.preventDefault();
  event.stopPropagation();
  accept(files);
}
export function dropFiles(event: DragEvent, accept: (files: File[]) => void) {
  const files = transferFiles(event.dataTransfer);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  accept(files);
}
export function allowFileDrop(event: DragEvent) {
  if (Array.from(event.dataTransfer.types).includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
}
