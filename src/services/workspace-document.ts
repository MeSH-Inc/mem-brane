import { createStore } from 'zustand/vanilla';
import type { CommandTask, CommandPhase } from './command-tasks';
import type { Block, BraneState, Placement } from '../../shared/types/domain';
type Run = BraneState['runs'][number];
type Activity = { busy: boolean; retry: boolean; phase?: CommandPhase };
export const idleActivity: Activity = { busy: false, retry: false };
export type Scene = Pick<BraneState, 'placements' | 'derivations'> & { braneId: string };
interface DocumentSnapshot {
  state?: BraneState;
  scene: Scene;
  blocks: Record<string, Block>;
  runs: Record<string, Run>;
  activity: Record<string, Activity>;
}
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
function entities<T extends { id: string }>(previous: T[], next: T[]) {
  if (previous === next) return previous;
  const known = new Map(previous.map((item) => [item.id, item]));
  const shared = next.map((item) => {
    const old = known.get(item.id);
    return old && same(old, item) ? old : item;
  });
  return previous.length === shared.length && shared.every((item, i) => item === previous[i])
    ? previous
    : shared;
}
// One reactive document projection. Entity identity is retained across equivalent
// refreshes; camera, composer and command status never invalidate scene geometry.
export class WorkspaceDocument {
  base?: BraneState;
  readonly store = createStore<DocumentSnapshot>(() => ({
    scene: { braneId: '', placements: [], derivations: [] },
    blocks: {},
    runs: {},
    activity: {},
  }));
  constructor(private project: (placements: Placement[]) => Placement[] = (p) => p) {}
  install(next: BraneState) {
    const previous = this.base;
    this.base = previous
      ? {
          brane: same(previous.brane, next.brane) ? previous.brane : next.brane,
          blocks: entities(previous.blocks, next.blocks),
          placements: entities(previous.placements, next.placements),
          runs: entities(previous.runs, next.runs),
          derivations: same(previous.derivations, next.derivations)
            ? previous.derivations
            : next.derivations,
        }
      : next;
    this.reproject();
  }
  reproject() {
    if (!this.base) return;
    const base = this.base,
      previous = this.store.getState();
    const placements = entities(previous.scene.placements, this.project(base.placements));
    const state = { ...base, placements };
    const scene =
      previous.scene.braneId === base.brane.id &&
      previous.scene.placements === placements &&
      previous.scene.derivations === base.derivations
        ? previous.scene
        : { braneId: base.brane.id, placements, derivations: base.derivations };
    const blocks =
      previous.state?.blocks === base.blocks
        ? previous.blocks
        : Object.fromEntries(base.blocks.map((b) => [b.id, b]));
    const runs =
      previous.state?.runs === base.runs
        ? previous.runs
        : Object.fromEntries(base.runs.map((r) => [r.output_block_id, r]));
    if (
      previous.state &&
      Object.keys(state).every(
        (key) => state[key as keyof BraneState] === previous.state![key as keyof BraneState],
      )
    )
      return;
    this.store.setState({ state, scene, blocks, runs });
  }
  activity(spawning: string[], retrying: string[], commands: Record<string, CommandTask> = {}) {
    const previous = this.store.getState().activity;
    const activity = Object.fromEntries(
      [...new Set([...spawning, ...retrying])].map((id) => {
        const next = {
          busy: spawning.includes(id),
          retry: retrying.includes(id),
          phase: commands[`spawn:${id}`]?.phase,
        };
        return [id, previous[id] && same(previous[id], next) ? previous[id] : next];
      }),
    );
    if (
      Object.keys(previous).length === Object.keys(activity).length &&
      Object.keys(activity).every((id) => activity[id] === previous[id])
    )
      return;
    this.store.setState({ activity });
  }
}
