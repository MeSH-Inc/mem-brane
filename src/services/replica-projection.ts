import type { BraneState, Block } from '../../shared/types/domain';
import type { WorkspaceCommand } from '../../shared/workspace-commands';
import type { ReplicaState } from './replica-storage';
import { blockResponse } from '../../shared/contracts';
import { MACHINE_TEMPLATE } from '../../shared/machines';

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
      (command.type === 'text.edit' || command.type === 'block.create') && command.blockId === id,
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
      state.workspaces[brane.id] = {
        brane,
        blocks: [],
        placements: [],
        feeds: [],
        relations: [],
        groups: [],
        runs: [],
        derivations: [],
        relationEntries: [],
        parts: [],
      };
      return brane;
    }
    case 'brane.title': {
      const brane = state.branes.find((b) => b.id === command.id);
      if (brane) brane.title = command.title;
      const workspace = state.workspaces[command.id];
      if (workspace) workspace.brane.title = command.title;
      return { ok: true };
    }
    case 'block.create': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.blocks.push({
        id: command.blockId,
        kind: command.kind,
        origin: 'authored',
        version: 0,
        content: {
          format: 'text',
          text: command.kind === 'machine' ? (command.template ?? MACHINE_TEMPLATE) : '',
        },
      });
      workspace.placements.push({
        id: command.placementId,
        block_id: command.blockId,
        brane_id: command.braneId,
        version: 0,
        z_index: 0,
        host_placement_id: null,
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
        host_placement_id: null,
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
        // What is on the card's back goes with it, and feeds cascade with either end,
        // as on the server.
        const removed = new Set([
          command.id,
          ...workspace.placements
            .filter((p) => p.host_placement_id === command.id)
            .map((p) => p.id),
        ]);
        workspace.placements = workspace.placements.filter((p) => !removed.has(p.id));
        workspace.relations = workspace.relations.filter(
          (r) => !removed.has(r.from_placement_id) && !removed.has(r.to_placement_id),
        );
        // A group loses the card, and goes when it has no card left.
        workspace.groups = workspace.groups
          .map((g) => ({ ...g, members: g.members.filter((id) => !removed.has(id)) }))
          .filter((g) => g.members.length);
        workspace.feeds = presentFeeds(workspace);
        // Retain block data locally: another pending operation may place it again.
      }
      return { ok: true };
    case 'placement.detach': {
      const placement = findPlacement(state, command.id);
      if (!placement) throw new Error('Placement no longer exists.');
      Object.assign(placement, {
        ...command.geometry,
        host_placement_id: null,
        version: command.version + 1,
      });
      return placement;
    }
    case 'feed.create': {
      const workspace = requireWorkspace(state, command.braneId);
      const feed = {
        id: command.id,
        brane_id: command.braneId,
        from_placement_id: command.fromPlacementId ?? null,
        from_group_id: command.fromGroupId ?? null,
        to_placement_id: command.toPlacementId,
        slot: command.slot,
        mode: 'together' as const,
        created_at: Date.now(),
      };
      workspace.feeds = [...workspace.feeds.filter((f) => f.id !== feed.id), feed];
      return feed;
    }
    case 'feed.mode': {
      const workspace = requireWorkspace(state, command.braneId);
      const feed = workspace.feeds.find((f) => f.id === command.id);
      if (!feed) throw new Error('This feed is no longer on the brane.');
      if (
        command.mode === 'each' &&
        workspace.feeds.some(
          (f) =>
            f.to_placement_id === feed.to_placement_id && f.slot !== feed.slot && f.mode === 'each',
        )
      )
        throw new Error('Another slot of this machine already runs each.');
      workspace.feeds = workspace.feeds.map((f) =>
        f.id === command.id ? { ...f, mode: command.mode } : f,
      );
      return { ok: true };
    }
    case 'feed.remove': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.feeds = workspace.feeds.filter((f) => f.id !== command.id);
      return { ok: true };
    }
    case 'relation.create': {
      const workspace = requireWorkspace(state, command.braneId);
      const relation = {
        id: command.id,
        brane_id: command.braneId,
        from_placement_id: command.fromPlacementId,
        to_placement_id: command.toPlacementId,
        label: command.label,
        created_at: Date.now(),
      };
      workspace.relations = [...workspace.relations.filter((r) => r.id !== relation.id), relation];
      return relation;
    }
    case 'relation.relabel': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.relations = workspace.relations.map((r) =>
        r.id === command.id ? { ...r, label: command.label } : r,
      );
      return { ok: true };
    }
    case 'relation.remove': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.relations = workspace.relations.filter((r) => r.id !== command.id);
      return { ok: true };
    }
    case 'group.create':
    case 'group.edit': {
      const workspace = requireWorkspace(state, command.braneId);
      const previous = workspace.groups.find((g) => g.id === command.id);
      if (command.type === 'group.edit' && !previous)
        throw new Error('This group is no longer on the brane.');
      // A card belongs to one group, as on the server.
      const taken = new Set(
        workspace.groups.filter((g) => g.id !== command.id).flatMap((g) => g.members),
      );
      if (command.members.some((id) => taken.has(id)))
        throw new Error('A card belongs to one group. Take it out of its group first.');
      const group = {
        id: command.id,
        brane_id: command.braneId,
        label: command.label,
        display: command.display,
        created_at: previous?.created_at ?? Date.now(),
        members: [...command.members],
      };
      workspace.groups = previous
        ? workspace.groups.map((g) => (g.id === group.id ? group : g))
        : [...workspace.groups, group];
      return group;
    }
    case 'group.remove': {
      const workspace = requireWorkspace(state, command.braneId);
      workspace.groups = workspace.groups.filter((g) => g.id !== command.id);
      workspace.feeds = presentFeeds(workspace);
      return { ok: true };
    }
  }
}
// Feeds whose card or group, and whose machine, are still on the brane.
function presentFeeds(workspace: Pick<BraneState, 'feeds' | 'placements' | 'groups'>) {
  const placed = new Set(workspace.placements.map((p) => p.id));
  const groups = new Set(workspace.groups.map((g) => g.id));
  return workspace.feeds.filter(
    (f) =>
      placed.has(f.to_placement_id) &&
      (f.from_placement_id ? placed.has(f.from_placement_id) : groups.has(f.from_group_id!)),
  );
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
      command.type === 'text.edit' || command.type === 'block.create' ? [command.blockId] : [],
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
    placements = new Set<string>(),
    feeds = new Set<string>(),
    relations = new Set<string>(),
    groups = new Set<string>();
  let title = false;
  for (const { command: c } of state.pending) {
    if (c.type === 'block.create' || c.type === 'text.edit') blocks.add(c.blockId);
    if (c.type === 'block.create') placements.add(c.placementId);
    if (c.type.startsWith('feed.') && 'id' in c) feeds.add(c.id);
    if (c.type.startsWith('relation.') && 'id' in c) relations.add(c.id);
    if (c.type.startsWith('group.') && 'id' in c) groups.add(c.id);
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
    feeds: [
      ...incoming.feeds.filter((f) => !feeds.has(f.id)),
      ...local.feeds.filter((f) => feeds.has(f.id)),
    ],
    relations: [
      ...incoming.relations.filter((r) => !relations.has(r.id)),
      ...local.relations.filter((r) => relations.has(r.id)),
    ],
    groups: [
      ...incoming.groups.filter((g) => !groups.has(g.id)),
      ...local.groups.filter((g) => groups.has(g.id)),
    ],
    blocks: incoming.blocks.map((block) =>
      blocks.has(block.id) ? (findBlock(state, block.id) ?? block) : block,
    ),
  };
  // A pending placement removal also removes the feeds, arrows and memberships that
  // touched it.
  const placed = new Set(next.placements.map((p) => p.id));
  next.relations = next.relations.filter(
    (r) => placed.has(r.from_placement_id) && placed.has(r.to_placement_id),
  );
  next.groups = next.groups
    .map((g) => ({ ...g, members: g.members.filter((id) => placed.has(id)) }))
    .filter((g) => g.members.length);
  next.feeds = presentFeeds(next);
  for (const placement of next.placements) {
    if (next.blocks.some((block) => block.id === placement.block_id)) continue;
    const block = findBlock(state, placement.block_id);
    if (block) next.blocks.push(block);
  }
  return next;
}
