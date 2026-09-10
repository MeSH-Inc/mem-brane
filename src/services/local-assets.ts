import { replica, replicaStorage } from './api';
const loading = new Map<string, Promise<Blob>>();
export async function localAsset(id: string): Promise<Blob> {
  const actor = replica.actor;
  if (!actor) throw new Error('Sign in to open this attachment.');
  const key = JSON.stringify([actor, id]);
  const existing = loading.get(key);
  if (existing) return existing;
  const work = (async () => {
    const cached = await replicaStorage.asset(actor, id);
    if (cached) return cached;
    const response = await fetch(`/api/assets/${id}`, {
      credentials: 'same-origin',
      headers: { 'X-Mem-Brane-Actor': actor },
    });
    if (!response.ok) throw new Error('Attachment unavailable. Reconnect and try again.');
    const blob = await response.blob();
    if (replica.actor !== actor) throw new Error('Account changed.');
    await replicaStorage.asset(actor, id, blob);
    return blob;
  })();
  loading.set(key, work);
  try {
    return await work;
  } finally {
    loading.delete(key);
  }
}
