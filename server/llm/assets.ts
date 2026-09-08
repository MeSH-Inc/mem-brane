import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { AssetStore } from '../storage/assets.js';
import { requireOwned, DomainError } from '../domain/access.js';
import type { RunInput } from '../../shared/types/domain.js';
import type { ModelMessage } from 'ai';
import { buildMessages } from './model.js';
export async function resolveMessages(
  db: DB,
  store: AssetStore,
  actor: string,
  inputs: RunInput[],
  signal?: AbortSignal,
): Promise<ModelMessage[]> {
  const messages = buildMessages(inputs);
  // Resolve exact bytes from frozen asset IDs + hashes. Mutable LiveState is never consulted.
  const cache = new Map<string, Uint8Array>();
  for (const [index, input] of inputs.entries()) {
    signal?.throwIfAborted();
    const content = input.content;
    if (!content.assetId) continue;
    const asset = requireOwned(db, 'assets', actor, content.assetId);
    if (!content.assetHash || !content.mimeType)
      throw new DomainError(
        409,
        'Image has no frozen integrity metadata. Re-upload before using it as context.',
      );
    let bytes = cache.get(content.assetId);
    if (!bytes) {
      bytes = await store.get(asset.storage_key, signal);
      signal?.throwIfAborted();
      cache.set(content.assetId, bytes);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== content.assetHash)
      throw new DomainError(409, 'Stored image no longer matches its submitted revision');
    const text = messages[index].content as string;
    messages[index] = {
      role: 'user',
      content: [
        { type: 'text', text },
        {
          type: 'image',
          image: bytes,
          mediaType: content.mimeType,
          providerOptions: { openai: { imageDetail: 'low' } },
        },
      ],
    };
  }
  return messages;
}
