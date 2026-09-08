import { Worker } from 'node:worker_threads';
import { DomainError } from '../domain/access.js';
import type { PdfContent } from '../../shared/types/domain.js';
export function inspectPdf(
  bytes: Uint8Array,
): Promise<Pick<PdfContent, 'pageCount' | 'representation'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
      execArgv: [], // This is a plain ESM worker; do not inherit dev/test loaders or inspector flags.
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    let finished = false;
    const finish = (error?: Error, value?: Pick<PdfContent, 'pageCount' | 'representation'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(value!);
      }, reject);
    };
    const timer = setTimeout(
      () =>
        finish(
          new DomainError(400, 'PDF processing exceeded 15 seconds. Try a smaller or simpler PDF.'),
        ),
      15000,
    );
    worker.once('message', (message) =>
      finish(message.error ? new DomainError(400, message.error) : undefined, message),
    );
    worker.once('error', (error) => {
      console.error('PDF worker failed', error);
      finish(new DomainError(400, 'PDF processing exceeded its memory limit or could not start.'));
    });
    worker.once('exit', () =>
      finish(new DomainError(400, 'PDF processing ended before extraction completed.')),
    );
    worker.postMessage(bytes);
  });
}
