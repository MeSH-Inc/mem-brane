import type { Content, WorkspaceContent } from './types/domain';
export function modelCompatibility(
  content: Content | WorkspaceContent,
  vision = true,
): string | undefined {
  if (content.format === 'image' && (content.frames ?? 1) > 1)
    return 'Animated images can be stored, but model context requires a still image.';
  if (content.format === 'image' && !vision) return 'This model does not support image context';
  if (content.format === 'pdf' && content.representation.status === 'unavailable')
    return content.representation.reason;
  if (content.format === 'webpage' && content.status !== 'ready')
    return 'Webpage text is not ready';
}
export function representationText(content: Content) {
  if (content.format !== 'pdf') return content.text;
  if (content.representation.status !== 'ready') return content.text;
  return `${content.filename}\n[PDF extracted text only; diagrams, images and visual layout are not included.]\n${content.representation.pages.map((page) => `[Page ${page.number}]\n${page.text || '[No extractable text on this page]'}`).join('\n\n')}`;
}
