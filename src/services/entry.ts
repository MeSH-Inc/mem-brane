import { client } from './client';
import { replicaLock } from './replica-locks';

const marker = 'mem-brane-has-workspace';
// A later expired session must not silently create a new empty guest workspace.
export async function openEntry(braneId?: string) {
  return replicaLock('mem-brane-bootstrap', 'exclusive', async () => {
    const session = await client.session(undefined, braneId);
    if (session) {
      localStorage.setItem(marker, '1');
      return { session, braneId: undefined };
    }
    if (localStorage.getItem(marker) || braneId) return { session: null, braneId: undefined };
    if (!(await client.entryPolicy()).guest) return { session: null, braneId: undefined };
    return enterGuest();
  });
}

export async function enterGuest() {
  const entry = await client.startGuest();
  localStorage.setItem(marker, '1');
  return entry;
}
