import { z } from 'zod';
import { sessionResponse, workspaceResponse, braneResponse } from '../../shared/contracts';
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
} from './replica-projection';
import type { ReplicaStorage, ReplicaState, PendingOperation } from './replica-storage';
import { networkApi, ApiError } from './transport';

type Status = { connected: boolean; pending: number; error: string; conflict?: PendingOperation };
const unavailable = (error: unknown) =>
  error instanceof ApiError
    ? error.status >= 500
    : error instanceof TypeError ||
      (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));

export class WorkspaceReplica {
  actor?: string;
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private channel?: BroadcastChannel;
  private status: Status = { connected: true, pending: 0, error: '' };
  private generation = 0;
  constructor(
    readonly storage: ReplicaStorage,
    private transport: typeof networkApi,
  ) {}
  private remote: typeof networkApi = (path, body, method, expectedActor = this.actor) =>
    this.transport(path, body, method, path.startsWith('/auth/') ? undefined : expectedActor);
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
      conflict: state.pending[0]?.failure ? state.pending[0] : undefined,
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
        if (event.data.actor === this.actor && this.actor) void this.changed(this.actor, false);
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
  private async authenticatedSession() {
    let session;
    try {
      session = sessionResponse.parse(await this.remote('/auth/get-session'));
      await this.storage.session(session);
      this.setStatus({ connected: true, error: '' });
    } catch (error) {
      if (!unavailable(error)) throw error;
      session = sessionResponse.parse(await this.storage.session());
      this.setStatus({ connected: false });
      if (!session) throw new Error('Connect and sign in once to open workspaces on this device.');
    }
    if (this.actor !== session?.user.id) ++this.generation;
    this.actor = session?.user.id;
    if (this.actor) {
      await this.changed(this.actor, false);
      void this.synchronize();
    } else this.setStatus({ pending: 0, conflict: undefined });
    return session;
  }
  request: typeof networkApi = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    if (path === '/auth/get-session') return this.authenticatedSession();
    if (path === '/auth/sign-out') {
      if (this.actor && (await this.storage.read(this.actor)).pending.length)
        throw new Error('Synchronize your local changes before signing out.');
      const result = await this.remote(path, body, method);
      await this.storage.session(null);
      this.actor = undefined;
      ++this.generation;
      this.setStatus({ pending: 0, conflict: undefined });
      return result;
    }
    if (!this.actor || path.startsWith('/auth/')) return this.remote(path, body, method);
    const actor = this.actor;
    // Ensure destinations exist locally before entering the atomic mutation.
    if (
      (path === '/blocks/text' || path === '/placements') &&
      body &&
      typeof body === 'object' &&
      'braneId' in body
    ) {
      const id = String(body.braneId);
      if (!(await this.storage.read(actor)).workspaces[id]) await this.request(`/branes/${id}`);
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
      // A paid or online-only action can never overtake unsynchronized edits.
      await this.synchronize();
      if (this.actor !== actor) throw new Error('Account changed. Reopen this workspace.');
      if (!this.status.connected || (await this.storage.read(actor)).pending.length)
        throw new ApiError(
          400,
          'Reconnect and synchronize local changes before using this action.',
        );
      return this.remote(path, body, method);
    }
    const state = await this.storage.read(actor);
    const cached = readLocal(state, path);
    if (
      cached !== undefined &&
      (state.pending.length || /^\/(representations\/[^/]+\/pages|revisions\/[^/]+)$/.test(path))
    )
      return cached;
    const sequence = state.sequence;
    const requestGeneration = await this.storage.change(actor, (current) => {
      const fetch = (current.fetches[path] ??= { issued: 0, received: 0 });
      return ++fetch.issued;
    });
    try {
      const value = await this.remote(path, undefined, 'GET', actor);
      if (this.actor !== actor) throw new Error('Account changed.');
      this.setStatus({ connected: true, error: '' });
      return await this.storage.change(actor, (current) => {
        if (current.sequence !== sequence || current.fetches[path].received > requestGeneration)
          return readLocal(current, path) ?? value;
        current.fetches[path].received = requestGeneration;
        if (path === '/branes') current.branes = z.array(braneResponse).parse(value);
        else if (/^\/branes\/[^/]+$/.test(path)) {
          const workspace = workspaceResponse.parse(value);
          installWorkspace(current, workspace);
        } else current.reads[path] = value;
        return readLocal(current, path) ?? value;
      });
    } catch (error) {
      if (!unavailable(error) || this.actor !== actor) throw error;
      this.setStatus({ connected: false });
      const latest = readLocal(await this.storage.read(actor), path);
      if (latest !== undefined) return latest;
      throw new Error(
        'This content is not available on this device. Open it while connected first.',
      );
    }
  };
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
    } else if (path === '/blocks/text' && method === 'POST')
      command = {
        type: 'text.create',
        ...body,
        blockId: crypto.randomUUID(),
        placementId: crypto.randomUUID(),
      };
    else if (path === '/blocks/live' && method === 'PATCH')
      command = { type: 'text.edit', ...body };
    else if (path === '/placements' && method === 'POST')
      command = { type: 'placement.create', ...body, id: crypto.randomUUID() };
    else if (/^\/placements\/[^/]+$/.test(path)) {
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
  synchronize = (): Promise<void> => {
    if (this.running) return this.running;
    const actor = this.actor;
    if (!actor) return Promise.resolve();
    const work = () => this.drain(actor, this.generation);
    const locked = (async () => {
      if (typeof navigator !== 'undefined' && navigator.locks)
        await navigator.locks.request(`mem-brane-sync:${actor}`, work);
      else await work();
    })();
    this.running = locked
      .catch((error) =>
        this.setStatus({
          error: error instanceof Error ? error.message : 'Local synchronization failed.',
        }),
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running!;
  };
  private async drain(actor: string, generation: number) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus({ connected: false });
      return;
    }
    // Revalidate the account before sending cached work. Never replay one actor's
    // outbox under another actor's cookies after an offline account switch.
    let session;
    try {
      session = sessionResponse.parse(await this.remote('/auth/get-session'));
    } catch {
      this.setStatus({ connected: false });
      return;
    }
    if (this.actor !== actor || this.generation !== generation) return;
    if (session?.user.id !== actor) {
      await this.storage.session(null);
      this.actor = undefined;
      ++this.generation;
      this.setStatus({
        connected: true,
        error: 'Sign in again to synchronize your local work.',
        pending: 0,
        conflict: undefined,
      });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:session-expired'));
      return;
    }
    const reconnected = !this.status.connected;
    this.setStatus({ connected: true });
    if (reconnected && typeof window !== 'undefined')
      window.dispatchEvent(new Event('brane:reconcile'));
    let wrote = false;
    let paused = false;
    while (this.actor === actor && this.generation === generation) {
      const head = (await this.storage.read(actor)).pending[0];
      if (!head || head.failure) break;
      try {
        const acknowledgement = workspaceAcknowledgement.parse(
          await this.remote(
            '/sync/commands',
            { key: head.key, command: head.command },
            'POST',
            actor,
          ),
        );
        if (acknowledgement.key !== head.key)
          throw new Error('Invalid synchronization acknowledgement.');
        await this.storage.change(actor, (state) => {
          if (state.pending[0]?.key === head.key) {
            state.pending.shift();
            state.sequence++;
          }
        });
        wrote = true;
      } catch (error) {
        if (error instanceof ApiError && [400, 403, 404, 409, 413, 422].includes(error.status)) {
          await this.storage.change(actor, (state) => {
            if (state.pending[0]?.key === head.key)
              state.pending[0].failure = { status: error.status, message: error.message };
          });
          paused = true;
          this.setStatus({ error: '' });
        } else
          this.setStatus({
            connected: error instanceof ApiError,
            error: error instanceof ApiError ? error.message : '',
          });
        break;
      }
    }
    if (wrote) this.setStatus({ error: '' });
    if (wrote || paused) await this.changed(actor, wrote);
  }
  async inspectConflict() {
    const actor = this.actor;
    if (!actor) throw new Error('Sign in to review this conflict.');
    const state = await this.storage.read(actor);
    const head = state.pending[0];
    if (!head?.failure) return undefined;
    const command = head.command;
    const workspace = Object.values(state.workspaces).find((w) =>
      command.type === 'text.edit'
        ? w.blocks.some((b) => b.id === command.blockId)
        : command.type === 'brane.title'
          ? w.brane.id === command.id
          : command.type === 'placement.remove'
            ? w.brane.id === command.braneId
            : 'id' in command && w.placements.some((p) => p.id === command.id),
    );
    if (!workspace) return { key: head.key, local: command, server: 'No cached source workspace.' };
    const current = workspaceResponse.parse(
      await this.remote(`/branes/${workspace.brane.id}`, undefined, 'GET', actor),
    );
    const server =
      command.type === 'text.edit'
        ? current.blocks.find((b) => b.id === command.blockId)
        : command.type === 'brane.title'
          ? current.brane
          : 'id' in command
            ? current.placements.find((p) => p.id === command.id)
            : undefined;
    return { key: head.key, local: command, server: server ?? 'Removed on server' };
  }
  async resolveConflict(choice: 'local' | 'server') {
    const actor = this.actor;
    if (!actor) return;
    const work = async () => {
      const initial = await this.storage.read(actor);
      const head = initial.pending[0];
      if (
        !head?.failure ||
        !['text.edit', 'placement.edit', 'placement.remove', 'brane.title'].includes(
          head.command.type,
        )
      )
        throw new Error(
          'This operation needs the reported server condition resolved before retrying.',
        );
      const entity = commandEntity(head.command);
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
        if (state.pending[0]?.key !== head.key)
          throw new Error('Another window resolved this conflict.');
        state.workspaces = remote;
        state.branes = state.branes.map((b) => remote[b.id]?.brane ?? b);
        const pending: PendingOperation[] = [];
        for (const entry of state.pending) {
          const matches = commandEntity(entry.command) === entity;
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
            } else if (c.type === 'placement.edit' || c.type === 'placement.remove') {
              const placement = findPlacement(state, c.id);
              if (!placement)
                throw new Error(
                  'This placement was removed. Choose server state, then place the block again.',
                );
              c.version = placement.version;
            } else if (c.type === 'brane.title') c.previous = state.workspaces[c.id].brane.title;
          }
          projectCommand(state, next.command);
          pending.push(next);
        }
        state.pending = pending;
        state.sequence++;
      });
      this.setStatus({ error: '' });
      await this.changed(actor);
      // Reset controller acknowledgement caches after explicit version rebasing.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('brane:replica-reset'));
    };
    if (typeof navigator !== 'undefined' && navigator.locks)
      await navigator.locks.request(`mem-brane-sync:${actor}`, work);
    else await work();
    await this.synchronize();
  }
  async retry() {
    const actor = this.actor;
    if (!actor) return;
    await this.storage.change(actor, (state) => {
      if (state.pending[0]) delete state.pending[0].failure;
    });
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
  return state.reads[path];
}
