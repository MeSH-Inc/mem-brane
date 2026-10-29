import { z } from 'zod';
import {
  sessionResponse,
  workspaceResponse,
  braneResponse,
  blockResponse,
} from '../../shared/contracts';
import {
  workspaceCommand,
  workspaceAcknowledgement,
  commandEntity,
  type WorkspaceCommand,
} from '../../shared/workspace-commands';
import {
  findBlock,
  findPlacement,
  projectCommand,
  visibleWorkspace,
  installWorkspace,
  installBlock,
  overlayPending,
} from './replica-projection';
import type { ReplicaStorage, ReplicaState, PendingOperation } from './replica-storage';
import type { BraneState } from '../../shared/types/domain';
import { submissionReceipt } from '../../shared/schemas';
import { networkApi, ApiError } from './transport';
import { requestAccount, accountFeatureReason } from './account-prompt';
import { commandAccess, requestResources, requiredOperations } from './command-dependencies';
import { ReplicaScheduler } from './replica-scheduler';
import { replicaGate, replicaLock } from './replica-locks';

type Status = {
  connected: boolean;
  pending: number;
  error: string;
  conflicts: PendingOperation[];
};
// A refused edit can be rebased onto server state; a refused creation can only be discarded.
const editCommands = new Set([
  'text.edit',
  'placement.edit',
  'placement.remove',
  'brane.title',
  'feed.remove',
]);
const creationCommands = new Set([
  'block.create',
  'placement.create',
  'brane.create',
  'feed.create',
]);
const unavailable = (error: unknown) =>
  error instanceof ApiError
    ? error.status >= 500
    : error instanceof TypeError ||
      (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));

export class WorkspaceReplica {
  // Replica identity is a content library, independent of the login principal.
  actor?: string;
  principal?: string;
  guest = false;
  private listeners = new Set<() => void>();
  private checking?: { actor: string; generation: number; result: Promise<boolean> };
  private scheduler: ReplicaScheduler;
  private channel?: BroadcastChannel;
  private reads = new Map<string, Promise<unknown>>();
  private status: Status = { connected: true, pending: 0, error: '', conflicts: [] };
  private generation = 0;
  constructor(
    readonly storage: ReplicaStorage,
    private transport: typeof networkApi,
  ) {
    this.scheduler = new ReplicaScheduler(storage, (actor, op) => this.dispatch(actor, op));
  }
  private remote: typeof networkApi = (path, body, method, expectedActor = this.actor) =>
    this.transport(
      path,
      body,
      method,
      path.startsWith('/auth/') ? undefined : expectedActor,
      path.startsWith('/auth/') || path.startsWith('/guest/') || path.startsWith('/session')
        ? undefined
        : this.principal,
    );
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.status;
  private setStatus(patch: Partial<Status>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  private async changed(actor: string, broadcast = true) {
    if (this.actor !== actor) return;
    const state = await this.storage.read(actor);
    if (this.actor !== actor) return;
    this.setStatus({
      pending: state.pending.length,
      conflicts: state.pending.filter((op) => op.failure),
    });
    if (broadcast) this.channel?.postMessage({ actor });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:local-change'));
  }
  start() {
    const reconnect = () => {
      void this.synchronize();
    };
    const offline = () => this.setStatus({ connected: false });
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', offline);
    const timer = setInterval(reconnect, 10000);
    if ('BroadcastChannel' in globalThis) {
      this.channel = new BroadcastChannel('mem-brane-replica');
      this.channel.onmessage = (event) => {
        if (event.data.type === 'session') window.dispatchEvent(new Event('brane:session-expired'));
        if (event.data.actor !== this.actor || !this.actor) return;
        void this.changed(this.actor, false);
        // Every tab drops its acknowledgement caches after a resolution rebased versions.
        if (event.data.type === 'reset') window.dispatchEvent(new Event('brane:replica-reset'));
      };
    }
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', offline);
      this.channel?.close();
      this.channel = undefined;
    };
  }
  private async authenticatedSession(path = '/session') {
    const saved = await this.storage.session();
    if (!this.actor) this.actor = saved?.libraryId;
    let session;
    try {
      session = sessionResponse.parse(await this.remote(path));
      this.setStatus({ connected: true, error: '' });
    } catch (error) {
      if (!unavailable(error)) throw error;
      session = sessionResponse.parse(await this.storage.session());
      this.setStatus({ connected: false });
      if (!session) throw new Error('Connect and sign in once to open workspaces on this device.');
    }
    if (session && !session.user.isAnonymous && session.claimPending)
      session = sessionResponse.parse(await this.remote('/guest/claim', {}));
    await this.storage.session(session);
    const principalChanged = this.principal !== session?.user.id;
    if (this.actor !== session?.libraryId || this.principal !== session?.user.id) ++this.generation;
    this.actor = session?.libraryId;
    this.principal = session?.user.id;
    this.guest = session?.user.isAnonymous ?? false;
    if (principalChanged) this.channel?.postMessage({ type: 'session' });
    if (this.actor) {
      await this.changed(this.actor, false);
      void this.synchronize();
    } else this.setStatus({ pending: 0, conflicts: [] });
    return session;
  }
  request: typeof networkApi = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    if (path === '/session' || path.startsWith('/session?')) return this.authenticatedSession(path);
    if (path === '/guest/start')
      return replicaLock('mem-brane-entry', 'exclusive', async () => {
        const value = await this.remote(path, body, method);
        await this.authenticatedSession();
        return value;
      });
    if (path === '/auth/sign-in/email' || path === '/auth/sign-up/email')
      return replicaLock('mem-brane-entry', 'exclusive', async () => {
        const current = sessionResponse.parse(await this.remote('/session'));
        if (current && !current.user.isAnonymous && current.claimPending) {
          await this.authenticatedSession();
          return { ok: true };
        }
        if (current?.user.isAnonymous)
          await this.remote('/guest/prepare-claim', {
            pending: this.actor ? (await this.storage.read(this.actor)).pending.length : 0,
          });
        const value = await this.remote(path, body, method);
        await this.authenticatedSession();
        this.channel?.postMessage({ type: 'session' });
        return value;
      });
    if (path === '/auth/sign-out') {
      if (this.actor && (await this.storage.read(this.actor)).pending.length)
        throw new Error('Synchronize your local changes before signing out.');
      const result = await this.remote(path, body, method);
      await this.storage.session(null);
      this.actor = undefined;
      this.principal = undefined;
      ++this.generation;
      this.setStatus({ pending: 0, conflicts: [] });
      return result;
    }
    if (!this.actor || path.startsWith('/auth/') || path.startsWith('/guest/'))
      return this.remote(path, body, method);
    if (
      this.guest &&
      method === 'POST' &&
      (/^\/(runs|artifacts|ingest)(\/|$)/.test(path) || path.endsWith('/snapshot'))
    ) {
      if (typeof window !== 'undefined' && path !== '/runs/estimate')
        requestAccount({ mode: 'signup', reason: accountFeatureReason });
      throw new ApiError(403, accountFeatureReason, 'guest_limit');
    }
    const actor = this.actor;
    if (method !== 'GET' && !isLocalMutation(path, method)) {
      const resources = requestResources(path, body);
      if (resources.length) {
        const pending = (await this.storage.read(actor)).pending;
        const keys = requiredOperations(pending, resources);
        // Capture only this action's prerequisites. Cancellation and retry of
        // immutable context bypass both local storage and synchronization.
        if (keys.length && !(await this.synchronizeOperations(actor, pending, keys)))
          throw new ApiError(
            409,
            'Resolve or synchronize changes to this action’s sources before retrying.',
          );
      }
      if (this.actor !== actor) throw new Error('Account changed. Reopen this workspace.');
      const result = await this.remote(path, body, method, actor);
      if (
        method === 'POST' &&
        (path === '/runs' || path === '/artifacts/spawn' || path === '/machines/run')
      )
        await this.acknowledgeEdits(actor, result);
      return result;
    }
    // Ensure destinations exist locally before entering the atomic mutation.
    if (
      (path === '/blocks/text' ||
        path === '/blocks/machine' ||
        path === '/placements' ||
        path === '/feeds') &&
      body &&
      typeof body === 'object' &&
      'braneId' in body
    ) {
      const id = String(body.braneId);
      if (!(await this.storage.read(actor)).workspaces[id]) await this.request(`/branes/${id}`);
      if (path === '/placements' && 'blockId' in body) {
        const blockId = String(body.blockId);
        if (!findBlock(await this.storage.read(actor), blockId))
          await this.request(`/blocks/${blockId}`);
      }
    }
    if (method !== 'GET') {
      const local = await this.storage.change(actor, (state) => {
        const command = this.toCommand(state, path, body, method);
        if (!command) return undefined;
        if (this.actor !== actor) throw new Error('Account changed. Reopen this workspace.');
        validateBase(state, command);
        const result = structuredClone(projectCommand(state, command));
        state.pending.push({ key: crypto.randomUUID(), command });
        state.sequence++;
        return { result };
      });
      if (local) {
        await this.changed(actor);
        void this.synchronize();
        return local.result;
      }
      throw new Error('Unsupported local mutation.');
    }
    const state = await this.storage.read(actor);
    const cached = readLocal(state, path);
    if (cached !== undefined && /^\/(representations\/[^/]+\/pages|revisions\/[^/]+)$/.test(path))
      return cached;
    if (cached !== undefined && state.pending.length) {
      const key = JSON.stringify([actor, path]);
      if (!this.reads.has(key)) {
        const reading = this.refreshRead(actor, path, state, true).catch(() => {});
        this.reads.set(key, reading);
        void reading.finally(() => {
          if (this.reads.get(key) === reading) this.reads.delete(key);
        });
      }
      return cached;
    }
    return this.refreshRead(actor, path, state);
  };
  private async refreshRead(actor: string, path: string, state: ReplicaState, notify = false) {
    const sequence = state.sequence;
    const requestGeneration = await this.storage.change(actor, (current) => {
      const fetch = (current.fetches[path] ??= { issued: 0, received: 0 });
      return ++fetch.issued;
    });
    try {
      const value = await this.remote(path, undefined, 'GET', actor);
      if (this.actor !== actor) throw new Error('Account changed.');
      this.setStatus({ connected: true, error: '' });
      const result = await this.storage.change(actor, (current) => {
        if (current.sequence !== sequence || current.fetches[path].received > requestGeneration)
          return { value: readLocal(current, path) ?? value, changed: false };
        const previous = JSON.stringify(readLocal(current, path));
        current.fetches[path].received = requestGeneration;
        if (path === '/branes') current.branes = z.array(braneResponse).parse(value);
        else if (/^\/branes\/[^/]+$/.test(path)) {
          const workspace = workspaceResponse.parse(value);
          installWorkspace(current, overlayPending(current, workspace));
        } else if (/^\/blocks\/[^/]+$/.test(path) && !path.startsWith('/blocks/unplaced'))
          installBlock(current, blockResponse.parse(value), true);
        else current.reads[path] = value;
        const next = readLocal(current, path) ?? value;
        return { value: next, changed: previous !== JSON.stringify(next) };
      });
      if (notify && result.changed) await this.changed(actor);
      return result.value;
    } catch (error) {
      if (!unavailable(error) || this.actor !== actor) throw error;
      this.setStatus({ connected: false });
      const latest = readLocal(await this.storage.read(actor), path);
      if (latest !== undefined) return latest;
      throw new Error(
        'This content is not available on this device. Open it while connected first.',
      );
    }
  }
  private toCommand(
    state: ReplicaState,
    path: string,
    raw: unknown,
    method: string,
  ): WorkspaceCommand | undefined {
    // The discriminated schema validates the complete command before storage.
    const body = raw as Record<string, unknown> | undefined;
    let command: unknown;
    if (path === '/branes' && method === 'POST')
      command = { type: 'brane.create', id: crypto.randomUUID(), title: body?.title };
    else if (/^\/branes\/[^/]+$/.test(path) && method === 'PATCH') {
      const id = path.split('/')[2];
      command = {
        type: 'brane.title',
        id,
        title: body?.title,
        previous: state.workspaces[id]?.brane.title ?? state.branes.find((b) => b.id === id)?.title,
      };
    } else if ((path === '/blocks/text' || path === '/blocks/machine') && method === 'POST')
      command = {
        type: 'block.create',
        kind: path === '/blocks/machine' ? 'machine' : 'text',
        ...body,
        blockId: crypto.randomUUID(),
        placementId: crypto.randomUUID(),
      };
    else if (path === '/blocks/live' && method === 'PATCH')
      command = { type: 'text.edit', ...body };
    else if (path === '/placements' && method === 'POST')
      command = { type: 'placement.create', ...body, id: crypto.randomUUID() };
    else if (path === '/feeds' && method === 'POST')
      command = { type: 'feed.create', ...body, id: crypto.randomUUID() };
    else if (/^\/feeds\/[^/]+$/.test(path) && method === 'DELETE') {
      const id = path.split('/')[2];
      command = {
        type: 'feed.remove',
        id,
        braneId: Object.values(state.workspaces).find((w) => w.feeds.some((f) => f.id === id))
          ?.brane.id,
      };
    } else if (/^\/placements\/[^/]+$/.test(path)) {
      const id = path.split('/')[2];
      if (method === 'PATCH') command = { type: 'placement.edit', id, ...body };
      else if (method === 'DELETE')
        command = {
          type: 'placement.remove',
          id,
          braneId: findPlacement(state, id)?.brane_id,
          version: findPlacement(state, id)?.version,
        };
    }
    return command ? workspaceCommand.parse(command) : undefined;
  }
  synchronize = async (): Promise<void> => {
    const actor = this.actor;
    if (!actor) return;
    try {
      await this.synchronizeOperations(actor, (await this.storage.read(actor)).pending);
    } catch (error) {
      if (this.actor === actor)
        this.setStatus({
          error: error instanceof Error ? error.message : 'Local synchronization failed.',
        });
    }
  };
  private async synchronizeOperations(actor: string, pending: PendingOperation[], keys?: string[]) {
    const generation = this.generation;
    if (!(await this.checkSession(actor, generation))) return false;
    return this.scheduler.synchronize(
      actor,
      pending,
      () => this.actor === actor && this.generation === generation,
      keys,
    );
  }
  private checkSession(actor: string, generation: number) {
    if (this.checking?.actor === actor && this.checking.generation === generation)
      return this.checking.result;
    const result = this.validateSession(actor, generation);
    this.checking = { actor, generation, result };
    const cleanup = () => {
      if (this.checking?.result === result) this.checking = undefined;
    };
    void result.then(cleanup, cleanup);
    return result;
  }
  private async validateSession(actor: string, generation: number) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus({ connected: false });
      return false;
    }
    let session;
    try {
      session = sessionResponse.parse(await this.remote('/session'));
    } catch {
      if (this.actor === actor) this.setStatus({ connected: false });
      return false;
    }
    if (this.actor !== actor || this.generation !== generation) return false;
    if (session?.libraryId === actor && session.user.id !== this.principal) {
      // A claim changes the principal while preserving this library and its outbox.
      // Refresh the shell without dropping the library hint or any local drafts.
      await this.authenticatedSession();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:session-expired'));
      return false;
    }
    if (session?.libraryId !== actor || session?.user.id !== this.principal) {
      await this.storage.session(null);
      this.actor = undefined;
      this.principal = undefined;
      ++this.generation;
      this.setStatus({
        connected: true,
        error: 'Sign in again to synchronize your local work.',
        pending: 0,
        conflicts: [],
      });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:session-expired'));
      return false;
    }
    const reconnected = !this.status.connected;
    this.setStatus({ connected: true });
    if (reconnected && typeof window !== 'undefined')
      window.dispatchEvent(new Event('brane:reconcile'));
    return true;
  }
  private async dispatch(actor: string, operation: PendingOperation): Promise<boolean> {
    try {
      const acknowledgement = workspaceAcknowledgement.parse(
        await this.remote(
          '/sync/commands',
          { key: operation.key, command: operation.command },
          'POST',
          actor,
        ),
      );
      if (acknowledgement.key !== operation.key)
        throw new Error('Invalid synchronization acknowledgement.');
      await this.storage.change(actor, (state) => {
        state.pending = state.pending.filter((op) => op.key !== operation.key);
        state.sequence++;
      });
      if (this.actor === actor) this.setStatus({ error: '' });
      await this.changed(actor);
      return true;
    } catch (error) {
      // A refusal that cannot succeed unchanged pauses this operation for review;
      // a retryable one (rate limit, full queue) stays queued for the next attempt.
      if (error instanceof ApiError && !error.retryable && error.code !== 'unauthenticated') {
        await this.storage.change(actor, (state) => {
          const current = state.pending.find((op) => op.key === operation.key);
          if (current) current.failure = { status: error.status, message: error.message };
        });
        if (this.actor === actor) this.setStatus({ error: '' });
        await this.changed(actor);
      } else if (this.actor === actor)
        this.setStatus({
          connected: error instanceof ApiError,
          error: error instanceof ApiError ? error.message : '',
        });
      return false;
    }
  }
  // Run and Develop save their sources' text on the server. The replica takes those
  // versions too; otherwise the next local edit would carry a stale base version
  // and be refused as a change from another window.
  private async acknowledgeEdits(actor: string, result: unknown) {
    const receipt = submissionReceipt.safeParse(result).data;
    if (!receipt?.edits.length) return;
    await this.storage.change(actor, (state) => {
      for (const edit of receipt.edits) {
        const block = findBlock(state, edit.blockId);
        if (block && block.version < edit.version)
          installBlock(state, { ...block, version: edit.version, content: edit.content });
      }
      state.sequence++;
    });
    await this.changed(actor);
  }
  // The local side is the item's final local state, not the first refused operation,
  // so the comparison shows everything a server choice would replace.
  async inspectConflict(key: string) {
    const actor = this.actor;
    if (!actor) throw new Error('Sign in to review this conflict.');
    const state = await this.storage.read(actor);
    const failed = state.pending.find((op) => op.key === key && op.failure);
    if (!failed) return undefined;
    const command = failed.command;
    const local = localState(state, command);
    const absent = creationCommands.has(command.type) ? 'Not on the server' : 'Removed on server';
    const braneId = commandBrane(state, command);
    if (!braneId) return { key, local, server: 'No cached source workspace.' };
    let current;
    try {
      current = workspaceResponse.parse(
        await this.remote(`/branes/${braneId}`, undefined, 'GET', actor),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { key, local, server: absent };
      throw error;
    }
    return { key, local, server: serverState(current, command) ?? absent };
  }
  async resolveConflict(key: string, choice: 'local' | 'server') {
    const actor = this.actor;
    if (!actor) return;
    const work = async () => {
      const initial = await this.storage.read(actor);
      const head = initial.pending.find((op) => op.key === key && op.failure);
      if (!head) throw new Error('Another window resolved this conflict.');
      const creation = creationCommands.has(head.command.type);
      if (!creation && !editCommands.has(head.command.type))
        throw new Error('This operation cannot be resolved here. Export your local changes.');
      if (creation && choice === 'local')
        throw new Error(
          'The server refused this creation. Discard it, or retry once the reported condition is resolved.',
        );
      const entity = commandEntity(head.command);
      // Choosing server text must not destroy the local text: it is kept as a copy.
      const preserved =
        choice === 'server' && head.command.type === 'text.edit'
          ? findBlock(initial, head.command.blockId)
          : undefined;
      const remote: ReplicaState['workspaces'] = {};
      for (const id of Object.keys(initial.workspaces)) {
        try {
          remote[id] = workspaceResponse.parse(
            await this.remote(`/branes/${id}`, undefined, 'GET', actor),
          );
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      if (this.actor !== actor) throw new Error('Account changed.');
      await this.storage.change(actor, (state) => {
        if (!state.pending.some((op) => op.key === head.key && op.failure))
          throw new Error('Another window resolved this conflict.');
        const placed = preserved && copyPlacement(state, preserved.id);
        state.workspaces = remote;
        if (head.command.type === 'text.edit')
          // Reset the detached projection too, so choosing server state cannot
          // resurrect a rejected local edit through a later card restoration.
          delete state.reads[`/blocks/${head.command.blockId}`];
        state.branes = state.branes.map((b) => remote[b.id]?.brane ?? b);
        const discarded = creation ? dependentOperations(state.pending, head.key) : new Set();
        const pending: PendingOperation[] = [];
        for (const entry of state.pending) {
          if (discarded.has(entry.key)) continue;
          const matches = !creation && commandEntity(entry.command) === entity;
          if (matches && choice === 'server') continue;
          const next = structuredClone(entry);
          if (matches) {
            next.key = crypto.randomUUID();
            delete next.failure;
            const c = next.command;
            if (c.type === 'text.edit') {
              const block = findBlock(state, c.blockId);
              if (!block)
                throw new Error(
                  'The source was removed. Export your local changes before choosing server state.',
                );
              c.version = block.version;
            } else if (c.type === 'placement.remove') {
              const placement = findPlacement(state, c.id);
              // Both sides removed it; the intent is already satisfied.
              if (!placement) continue;
              c.version = placement.version;
            } else if (c.type === 'placement.edit') {
              const placement = findPlacement(state, c.id);
              if (!placement)
                throw new Error(
                  'This placement was removed. Choose server state, then place the block again.',
                );
              c.version = placement.version;
            } else if (c.type === 'brane.title') c.previous = state.workspaces[c.id].brane.title;
          }
          pending.push(project(state, next));
        }
        if (preserved && placed) {
          const server = findBlock(state, preserved.id);
          if (preserved.content.text && preserved.content.text !== server?.content.text) {
            const blockId = crypto.randomUUID();
            for (const command of [
              {
                type: 'block.create' as const,
                kind: 'text' as const,
                braneId: placed.brane_id,
                blockId,
                placementId: crypto.randomUUID(),
                geometry: {
                  x: placed.x + 32,
                  y: placed.y + 32,
                  width: placed.width,
                  height: placed.height,
                },
              },
              { type: 'text.edit' as const, blockId, text: preserved.content.text, version: 0 },
            ])
              pending.push(project(state, { key: crypto.randomUUID(), command }));
          }
        }
        state.pending = pending;
        state.sequence++;
      });
      this.setStatus({ error: '' });
      await this.changed(actor, false);
      // Reset controller acknowledgement caches after explicit version rebasing.
      this.channel?.postMessage({ actor, type: 'reset' });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:replica-reset'));
    };
    await replicaLock(replicaGate(actor), 'exclusive', work);
    await this.synchronize();
  }
  // Without a key every paused operation is attempted again.
  async retry(key?: string) {
    const actor = this.actor;
    if (!actor) return;
    await this.storage.change(actor, (state) => {
      for (const op of state.pending) if (key === undefined || op.key === key) delete op.failure;
    });
    await this.changed(actor);
    await this.synchronize();
  }
  async exportLocal() {
    if (!this.actor) throw new Error('Sign in to export local work.');
    return {
      format: 'mem-brane-local-v1',
      actor: this.actor,
      ...(await this.storage.read(this.actor)),
    };
  }
}
// Re-applying one queued operation must not abort the resolution of the others:
// an operation whose target is gone is paused for its own review instead.
function project(state: ReplicaState, operation: PendingOperation): PendingOperation {
  try {
    projectCommand(state, operation.command);
    return operation;
  } catch (error) {
    return {
      ...operation,
      failure: operation.failure ?? { status: 409, message: (error as Error).message },
    };
  }
}
// A discarded creation takes every queued operation that needs what it created.
function dependentOperations(pending: PendingOperation[], key: string) {
  const keys = new Set<string>();
  const created = new Set<string>();
  for (const operation of pending) {
    const { reads, writes } = commandAccess(operation.command);
    if (operation.key !== key && ![...reads, ...writes].some((r) => created.has(r))) continue;
    keys.add(operation.key);
    for (const resource of writes) if (resource.endsWith(':exists')) created.add(resource);
  }
  return keys;
}
function copyPlacement(state: ReplicaState, blockId: string) {
  return Object.values(state.workspaces)
    .flatMap((w) => w.placements)
    .find((p) => p.block_id === blockId);
}
function commandBrane(state: ReplicaState, command: WorkspaceCommand): string | undefined {
  switch (command.type) {
    case 'brane.create':
    case 'brane.title':
      return command.id;
    case 'block.create':
    case 'placement.create':
    case 'placement.remove':
    case 'feed.create':
    case 'feed.remove':
      return command.braneId;
    case 'text.edit':
      return Object.values(state.workspaces).find((w) =>
        w.blocks.some((b) => b.id === command.blockId),
      )?.brane.id;
    case 'placement.edit':
      return findPlacement(state, command.id)?.brane_id;
  }
}
function localState(state: ReplicaState, command: WorkspaceCommand): unknown {
  switch (command.type) {
    case 'brane.create':
    case 'brane.title':
      return state.workspaces[command.id]?.brane ?? command;
    case 'block.create':
    case 'text.edit':
      return findBlock(state, command.blockId) ?? command;
    case 'placement.create':
    case 'placement.edit':
      return findPlacement(state, command.id) ?? command;
    case 'placement.remove':
    case 'feed.remove':
      return command;
    case 'feed.create':
      return (
        Object.values(state.workspaces)
          .flatMap((w) => w.feeds)
          .find((f) => f.id === command.id) ?? command
      );
  }
}
function serverState(current: BraneState, command: WorkspaceCommand): unknown {
  switch (command.type) {
    case 'brane.create':
    case 'brane.title':
      return current.brane;
    case 'block.create':
    case 'text.edit':
      return current.blocks.find((b) => b.id === command.blockId);
    case 'feed.create':
    case 'feed.remove':
      return current.feeds.find((f) => f.id === command.id);
    default:
      return current.placements.find((p) => p.id === command.id);
  }
}
function validateBase(state: ReplicaState, command: WorkspaceCommand) {
  if (command.type === 'text.edit') {
    const block = findBlock(state, command.blockId);
    if (!block || block.version !== command.version)
      throw new ApiError(
        409,
        'This text changed in another window. Review the current text before saving.',
      );
  } else if (command.type === 'placement.edit' || command.type === 'placement.remove') {
    if (findPlacement(state, command.id)?.version !== command.version)
      throw new ApiError(
        409,
        'This placement changed in another window. Review your move before retrying.',
      );
  }
}
function readLocal(state: ReplicaState, path: string): unknown {
  if (path === '/branes') return state.branes;
  if (/^\/branes\/[^/]+$/.test(path)) {
    const value = state.workspaces[path.split('/')[2]];
    return value ? visibleWorkspace(value) : undefined;
  }
  if (/^\/placements\/[^/]+$/.test(path)) return findPlacement(state, path.split('/')[2]);
  if (/^\/blocks\/[^/]+$/.test(path) && !path.startsWith('/blocks/unplaced'))
    return findBlock(state, path.split('/')[2]);
  return state.reads[path];
}

function isLocalMutation(path: string, method: string): boolean {
  if (path === '/branes') return method === 'POST';
  if (/^\/branes\/[^/]+$/.test(path)) return method === 'PATCH';
  if (['/blocks/text', '/blocks/machine', '/placements', '/feeds'].includes(path))
    return method === 'POST';
  if (/^\/feeds\/[^/]+$/.test(path)) return method === 'DELETE';
  if (path === '/blocks/live') return method === 'PATCH';
  return /^\/placements\/[^/]+$/.test(path) && ['PATCH', 'DELETE'].includes(method);
}
