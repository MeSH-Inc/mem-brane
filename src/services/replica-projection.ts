import type { BraneState } from '../../shared/types/domain';
import type { WorkspaceCommand } from '../../shared/workspace-commands';
import type { ReplicaState } from './replica-storage';

export function findBlock(state: ReplicaState, id: string) {
  return Object.values(state.workspaces)
    .flatMap((w) => w.blocks)
    .find((b) => b.id === id);
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
      let result;
      for (const workspace of Object.values(state.workspaces)) {
        const block = workspace.blocks.find((b) => b.id === command.blockId);
        if (!block) continue;
        if (
          block.origin !== 'authored' ||
          (block.content.format !== 'text' && block.content.format !== 'webpage')
        )
          throw new Error('This artifact cannot be edited.');
        const next =
          block.content.format === 'webpage'
            ? { ...block.content, text: command.text, status: 'ready' as const, error: undefined }
            : { ...block.content, text: command.text };
        block.version =
          command.version + (JSON.stringify(next) === JSON.stringify(block.content) ? 0 : 1);
        block.content = next;
        result = { version: block.version, content: block.content };
      }
      if (!result) throw new Error('Open this block online before editing it offline.');
      return result;
    }
    case 'placement.create': {
      const workspace = requireWorkspace(state, command.braneId);
      const block = findBlock(state, command.blockId);
      if (!block) throw new Error('This block is unavailable on this device.');
      if (!workspace.blocks.some((b) => b.id === block.id))
        workspace.blocks.push(structuredClone(block));
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
