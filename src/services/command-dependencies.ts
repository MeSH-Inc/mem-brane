import type { WorkspaceCommand } from '../../shared/workspace-commands';
import type { PendingOperation } from './replica-storage';

export type CommandAccess = { reads: string[]; writes: string[] };
const exists = (kind: string, id: string) => `${kind}:${id}:exists`;
const value = (kind: string, id: string) => `${kind}:${id}:value`;

// Existence and mutable values are distinct resources: editing a brane's title
// cannot delay a block in that brane, but creating the brane must precede it.
export function commandAccess(c: WorkspaceCommand): CommandAccess {
  switch (c.type) {
    case 'brane.create':
      return { reads: [], writes: [exists('brane', c.id), value('brane', c.id)] };
    case 'brane.title':
      return { reads: [exists('brane', c.id)], writes: [value('brane', c.id)] };
    case 'text.create':
      return {
        reads: [exists('brane', c.braneId)],
        writes: [
          exists('block', c.blockId),
          value('block', c.blockId),
          exists('placement', c.placementId),
          value('placement', c.placementId),
        ],
      };
    case 'text.edit':
      return { reads: [exists('block', c.blockId)], writes: [value('block', c.blockId)] };
    case 'placement.create':
      return {
        reads: [exists('brane', c.braneId), exists('block', c.blockId)],
        writes: [exists('placement', c.id), value('placement', c.id)],
      };
    case 'placement.edit':
      return { reads: [exists('placement', c.id)], writes: [value('placement', c.id)] };
    case 'placement.remove':
      return { reads: [], writes: [exists('placement', c.id), value('placement', c.id)] };
  }
}
export function operationDependencies(operations: PendingOperation[]) {
  const writers = new Map<string, string>();
  const readers = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();
  for (const operation of operations) {
    const { reads, writes } = commandAccess(operation.command);
    const before = new Set<string>();
    for (const resource of [...reads, ...writes]) {
      const writer = writers.get(resource);
      if (writer) before.add(writer);
    }
    for (const resource of writes) {
      for (const reader of readers.get(resource) ?? []) before.add(reader);
      readers.delete(resource);
      writers.set(resource, operation.key);
    }
    for (const resource of reads) {
      if (writes.includes(resource)) continue;
      if (!readers.has(resource)) readers.set(resource, new Set());
      readers.get(resource)!.add(operation.key);
    }
    dependencies.set(operation.key, before);
  }
  return dependencies;
}

// These endpoints consume only explicit sources or immutable server identities.
// Cancellation and retry of an already-frozen run have no local prerequisites.
export function requestResources(path: string, raw: unknown): string[] {
  let body = raw as Record<string, any> | undefined;
  if (typeof FormData !== 'undefined' && raw instanceof FormData) {
    const intent = raw.get('intent');
    body = typeof intent === 'string' ? JSON.parse(intent) : undefined;
  }
  const resources: string[] = [];
  if (typeof body?.braneId === 'string') resources.push(exists('brane', body.braneId));
  if (path === '/runs' || path === '/artifacts/spawn' || path === '/runs/estimate') {
    const sources = new Set<string>([
      ...(body?.references ?? []),
      ...(body?.sourceBlockIds ?? []),
      ...(body?.edits ?? []).map((e: { blockId: string }) => e.blockId),
    ]);
    for (const id of sources) resources.push(exists('block', id), value('block', id));
    if (body?.anchorPlacementId)
      resources.push(
        exists('placement', body.anchorPlacementId),
        value('placement', body.anchorPlacementId),
      );
  }
  const snapshot = path.match(/^\/blocks\/([^/]+)\/snapshot$/);
  if (snapshot) resources.push(exists('block', snapshot[1]), value('block', snapshot[1]));
  return resources;
}
export function requiredOperations(operations: PendingOperation[], resources: string[]) {
  const required = new Set(resources);
  return operations
    .filter((op) => commandAccess(op.command).writes.some((r) => required.has(r)))
    .map((op) => op.key);
}
