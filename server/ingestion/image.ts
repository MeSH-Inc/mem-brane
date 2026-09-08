import sharp from 'sharp';
import { DomainError } from '../domain/access.js';
import type { ImageContent } from '../../shared/types/domain.js';

export async function inspectImage(bytes: Uint8Array) {
  try {
    const decoder = sharp(bytes, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: 20_000_000,
    });
    const info = await decoder.metadata();
    const formats: Record<string, ImageContent['mimeType']> = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mimeType = formats[info.format ?? ''];
    if (!mimeType || !info.width || !info.height || (info.pages ?? 1) > 100)
      throw new Error('Unsupported image');
    // Metadata alone accepts truncated files. Decode every frame before publishing bytes.
    await decoder.raw().toBuffer();
    return {
      mimeType,
      width: info.width,
      height: info.pageHeight ?? info.height,
      frames: info.pages ?? 1,
    };
  } catch {
    throw new DomainError(
      400,
      'Choose a valid PNG, JPEG, GIF or WebP image (up to 20 million total pixels and 100 frames)',
    );
  }
}
