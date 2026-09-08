import { createHash } from 'node:crypto';
import pdfPackage from 'pdfjs-dist/package.json' with { type: 'json' };
import sharp from 'sharp';
import { canonicalJson } from '../domain/canonical.js';
export const pdfLimits = Object.freeze({
  pages: 100,
  characters: 20000,
  textBytes: 24000,
  timeoutMs: 15000,
  oldGenerationMb: 128,
  youngGenerationMb: 32,
});
export const imageLimits = Object.freeze({ pixels: 20_000_000, frames: 100 });
export const extractionPolicies = {
  pdf: {
    format: 'pdf',
    implementation: 'pdf-text-v1',
    parser: pdfPackage.version,
    limits: pdfLimits,
    options: {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      stopAtErrors: true,
      enableXfa: false,
      verbosity: 0,
    },
  },
  image: {
    format: 'image',
    implementation: 'original-image-v1',
    parser: sharp.versions,
    limits: imageLimits,
    options: { animated: true, failOn: 'warning' },
  },
};
export function policyIdentity(policy: unknown) {
  const json = canonicalJson(policy);
  return { id: createHash('sha256').update(json).digest('hex'), json };
}
