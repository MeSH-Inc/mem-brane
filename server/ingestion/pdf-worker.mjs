// Parse untrusted PDF data in a disposable isolate. No rendering, scripts, links or remote fetches.
import { parentPort } from 'node:worker_threads';
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
async function extract(bytes) {
  let loadingTask;
  const extractor = `pdfjs-${version}`;
  try {
    loadingTask = getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      stopAtErrors: true,
      enableXfa: false,
      verbosity: 0,
    });
    const document = await loadingTask.promise;
    const pageCount = document.numPages;
    const unavailable = (reason) => ({
      pageCount,
      representation: { kind: 'pdf-text-v1', extractor, status: 'unavailable', reason },
    });
    if (pageCount > 100) {
      return unavailable('Text extraction is limited to 100 pages. The original PDF is retained.');
    }
    const pages = [];
    let characters = 0,
      textBytes = 0;
    for (let number = 1; number <= pageCount; number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      let text = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!('str' in item)) continue;
          const part = item.str + (item.hasEOL ? '\n' : ' ');
          characters += part.length;
          // Include JSON escaping in the representation budget, not just raw UTF-8 bytes.
          textBytes += Buffer.byteLength(JSON.stringify(part));
          if (characters > 20000 || textBytes > 24000) {
            await reader.cancel(new Error('Extraction size limit reached'));
            return unavailable(
              'Extracted text exceeds the supported size. The original PDF is retained; no partial text will be sent.',
            );
          }
          text += part;
        }
      }
      pages.push({ number, text: text.trim() });
      page.cleanup();
    }
    if (!pages.some((page) => page.text)) {
      return unavailable(
        'This PDF has no extractable text. OCR is not available; the original PDF is retained.',
      );
    }
    return {
      pageCount,
      representation: { kind: 'pdf-text-v1', extractor, status: 'ready', pages },
    };
  } finally {
    await loadingTask?.destroy();
  }
}
parentPort.once('message', async (bytes) => {
  let result;
  try {
    result = await extract(bytes);
  } catch (error) {
    result = {
      error:
        error?.name === 'PasswordException'
          ? 'Password-protected PDFs are not supported. Choose an unlocked PDF.'
          : 'The PDF could not be parsed. Choose a valid, unencrypted PDF.',
    };
  }
  // Publish exactly once, after the PDF loading task has released its resources.
  parentPort.postMessage(result);
  parentPort.close();
});
