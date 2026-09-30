import type { BraneState, Block } from '../../shared/types/domain';
import type { WorkspaceCommand } from '../../shared/workspace-commands';
import type { ReplicaState } from './replica-storage';
import { blockResponse } from '../../shared/contracts';

export function findBlock(state: ReplicaState, id: string) {
  let found: Block | undefined;
  for (const workspace of Object.values(state.workspaces))
    for (const block of workspace.blocks) if (block.id === id) found = newestBlock(found, block);
  // Workspace blocks carry the projection of pending edits. A detached server
  // read must not replace that intent before its conflict is resolved.
  if (found && hasPendingText(state, id)) return found;
  const detached = blockResponse.safeParse(state.reads[`/blocks/${id}`]).data;
  return detached ? newestBlock(found, detached) : found;
}
function hasPendingText(state: ReplicaState, id: string) {
  return state.pending.some(
    ({ command }) =>
      (command.type === 'text.edit' || command.type === 'text.create') && command.blockId === id,
  );
}
function newestBlock(previous: Block | undefined, incoming: Block): Block {
  if (!previous) return incoming;
  if (previous.version !== incoming.version)
    return previous.version > incoming.version ? previous : incoming;
  // Generated blocks remain version zero as checkpoints become final output.
  if (previous.origin === 'generated') {
    if (previous.messageId && !incoming.messageId) return previous;
    if (incoming.messageId) return incoming;
    if (previous.content.text.length > incoming.content.text.length) return previous;
  }
  return incoming;
}
export function installBlock(state: ReplicaState, incoming: Block, detached = false): Block {
  const previous = findBlock(state, incoming.id);
  const block =
    previous && hasPendingText(state, incoming.id) ? previous : newestBlock(previous, incoming);
  for (const workspace of Object.values(state.workspaces))
    workspace.blocks = workspace.blocks.map((cached) =>
      cached.id === block.id ? structuredClone(block) : cached,
    );
  const path = `/blocks/${block.id}`;
  if (detached || state.reads[path] !== undefined) state.reads[path] = structuredClone(block);
  return block;
}
export function findPlacement(state: ReplicaState, id: string) {
  return Object.values(state.workspaces)
    .flatMap((w) => w.placements)
    .find((p) => p.id === id);
}
export function projectCommand(state: ReplicaState, command: WorkspaceCommand): unknown {
  switch (command.type) {
    case 'brane.create': {
      const brane = {
        id: command.id,
        title: command.title,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      state.branes = [brane, ...state.branes.filter((b) => b.id !== brane.id)];
      state.workspaces[brane.id] = { brane, blocks: [], placements: [], runs: [], derivations: [] };
      return brane;
    }
    case 'brane.title': {
      const brane = state.branes.find((b) => b.id === command.id);
      if (brane) brane.title = command.title;
      const workspace = state.workspaces[command.id];
      if (workspace) workspace.brane.title = command.title;
      return { ok: true };
    }
    case 'text.create': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.blocks.push({
        id: command.blockId,
        kind: 'text',
        origin: 'authored',
        version: 0,
        content: { format: 'text', text: '' },
      });
      workspace.placements.push({
        id: command.placementId,
        block_id: command.blockId,
        brane_id: command.braneId,
        version: 0,
        z_index: 0,
        ...command.geometry,
      });
      return { id: command.blockId };
    }
    case 'text.edit': {
      const block = findBlock(state, command.blockId);
      if (!block) throw new Error('Open this block online before editing it offline.');
      if (
        block.origin !== 'authored' ||
        (block.content.format !== 'text' && block.content.format !== 'webpage')
      )
        throw new Error('This artifact cannot be edited.');
      const next =
        block.content.format === 'webpage'
          ? { ...block.content, text: command.text, status: 'ready' as const, error: undefined }
          : { ...block.content, text: command.text };
      const version =
        command.version + (JSON.stringify(next) === JSON.stringify(block.content) ? 0 : 1);
      for (const workspace of Object.values(state.workspaces))
        workspace.blocks = workspace.blocks.map((b) =>
          b.id === block.id ? { ...b, version, content: structuredClone(next) } : b,
        );
      if (state.reads[`/blocks/${block.id}`] !== undefined)
        state.reads[`/blocks/${block.id}`] = { ...block, version, content: structuredClone(next) };
      return { version, content: next };
    }
    case 'placement.create': {
      const workspace = requireWorkspace(state, command.braneId);
      const block = findBlock(state, command.blockId);
      if (!block) throw new Error('This block is unavailable on this device.');
      if (workspace.blocks.some((cached) => cached.id === block.id))
        workspace.blocks = workspace.blocks.map((cached) =>
          cached.id === block.id ? structuredClone(block) : cached,
        );
      else workspace.blocks.push(structuredClone(block));
      const placement = {
        id: command.id,
        block_id: command.blockId,
        brane_id: command.braneId,
        version: 0,
        z_index: 0,
        ...command.geometry,
      };
      workspace.placements.push(placement);
      return placement;
    }
    case 'placement.edit': {
      const placement = findPlacement(state, command.id);
      if (!placement) throw new Error('Placement no longer exists.');
      Object.assign(placement, {
        x: command.x,
        y: command.y,
        width: command.width,
        height: command.height,
        version: command.version + 1,
      });
      return placement;
    }
    case 'placement.remove':
      for (const workspace of Object.values(state.workspaces)) {
        workspace.placements = workspace.placements.filter((p) => p.id !== command.id);
        // Retain block data locally: another pending operation may place it again.
      }
      return { ok: true };
  }
}
function requireWorkspace(state: ReplicaState, id: string): BraneState {
  const workspace = state.workspaces[id];
  if (!workspace) throw new Error('Open this brane online once to make it available offline.');
  return workspace;
}
export function visibleWorkspace(workspace: BraneState): BraneState {
  return {
    ...workspace,
    blocks: workspace.blocks.filter((b) => workspace.placements.some((p) => p.block_id === b.id)),
  };
}

// A block has one identity even when several cached branes place it. Installing
// one brane must propagate newer block versions without reverting another view.
export function installWorkspace(state: ReplicaState, workspace: BraneState) {
  const known = new Map<string, Block>();
  for (const cached of Object.values(state.workspaces))
    for (const block of cached.blocks) known.set(block.id, newestBlock(known.get(block.id), block));
  const pending = new Set(
    state.pending.flatMap(({ command }) =>
      command.type === 'text.edit' || command.type === 'text.create' ? [command.blockId] : [],
    ),
  );
  workspace.blocks = workspace.blocks.map((block) => {
    let previous = known.get(block.id);
    const detached = blockResponse.safeParse(state.reads[`/blocks/${block.id}`]).data;
    if (detached && (!previous || !pending.has(block.id)))
      previous = newestBlock(previous, detached);
    return structuredClone(
      previous && pending.has(block.id) ? previous : newestBlock(previous, block),
    );
  });
  const incoming = new Map(workspace.blocks.map((block) => [block.id, block]));
  for (const cached of Object.values(state.workspaces))
    cached.blocks = cached.blocks.map((block) =>
      incoming.has(block.id) ? structuredClone(incoming.get(block.id)!) : block,
    );
  for (const block of workspace.blocks)
    if (state.reads[`/blocks/${block.id}`] !== undefined)
      state.reads[`/blocks/${block.id}`] = structuredClone(block);
  state.workspaces[workspace.brane.id] = workspace;
}

// Refresh server-owned runs and unrelated entities while preserving the exact
// local projection of pending writes, including placement tombstones.
export function overlayPending(state: ReplicaState, incoming: BraneState): BraneState {
  const local = state.workspaces[incoming.brane.id];
  if (!local || !state.pending.length) return incoming;
  const blocks = new Set<string>(),
    placements = new Set<string>();
  let title = false;
  for (const { command: c } of state.pending) {
    if (c.type === 'text.create' || c.type === 'text.edit') blocks.add(c.blockId);
    if (c.type === 'text.create') placements.add(c.placementId);
    if (c.type.startsWith('placement.') && 'id' in c) placements.add(c.id);
    if ((c.type === 'brane.create' || c.type === 'brane.title') && c.id === incoming.brane.id)
      title = true;
  }
  const next = {
    ...incoming,
    brane: title ? { ...incoming.brane, title: local.brane.title } : incoming.brane,
    placements: [
      ...incoming.placements.filter((p) => !placements.has(p.id)),
      ...local.placements.filter((p) => placements.has(p.id)),
    ],
    blocks: incoming.blocks.map((block) =>
      blocks.has(block.id) ? (findBlock(state, block.id) ?? block) : block,
    ),
  };
  for (const placement of next.placements) {
    if (next.blocks.some((block) => block.id === placement.block_id)) continue;
    const block = findBlock(state, placement.block_id);
    if (block) next.blocks.push(block);
  }
  return next;
}
