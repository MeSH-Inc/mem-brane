import type { OcrResult } from '../../shared/ocr';

export function ocrResult(pages: number, text = 'Verified extraction'): OcrResult {
  return {
    document: {
      version: 'ocr-pages-v1',
      pages: Array.from({ length: pages }, (_, i) => ({
        page: i + 1,
        width: 600,
        height: 800,
        markdown: `${text} ${i + 1}`,
        blocks: [
          {
            id: `p${i + 1}-b1`,
            type: 'text',
            text: `${text} ${i + 1}`,
            bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
          },
        ],
      })),
    },
    evidence: { provider: 'test', model: 'ocr-test', response: { confirmedPages: pages } },
  };
}
