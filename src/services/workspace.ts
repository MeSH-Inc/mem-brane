import { createClient, type Client } from './client';
import type { Budget, Estimate, Configuration, RunDetail, RunEvent } from '../../shared/contracts';
import type {
  BraneState,
  Geometry,
  SubmitRun,
  SpawnArtifact,
  EditReceipt,
  Edit,
  SubmissionReceipt,
} from '../../shared/types/domain';
import type { ConversationMessage } from '../../shared/types/conversation';
import { submitRun, spawnArtifact } from '../../shared/schemas';
import { modelCompatibility } from '../../shared/representations';
import { api, ApiError } from './api';
import { PlacementSaves } from './placement-saves';
import { TextSaves } from './text-saves';
import { WorkspaceDocument } from './workspace-document';
import { Submission } from './submission';
import { RequestJournal } from './request-journal';
import { WorkspaceDrafts, type WorkspaceDraft, type WorkspaceStorage } from './workspace-drafts';
import { draftDisposition, type Draft } from './drafts';
import type { Interaction } from '../stores/interaction';
import type { Imports } from './imports';

type DraftState = Pick<
  Interaction,
  | 'actor'
  | 'draftRecords'
  | 'drafts'
  | 'draft'
  | 'clearDraft'
  | 'rebase'
  | 'flushRecovery'
  | 'recoverDraft'
  | 'discardDraft'
  | 'refreshDrafts'
>;
export interface WorkspaceDependencies {
  request: typeof api;
  storage: WorkspaceStorage;
  drafts: { getState(): DraftState; subscribe(listener: () => void): () => void };
  imports: Pick<Imports, 'subscribe' | 'list' | 'enqueue' | 'delivered' | 'maxBytes'>;
  events: EventTarget;
}
type Prepared<T> = { payload: T; draftKeys: Record<string, string> };
type Capabilities = Configuration['modelCapabilities'];
export type Inspection = RunDetail;

// Owns the lifetime of one mounted workspace. React only subscribes and dispatches commands.
// Already-sent requests may commit after disposal; their journals/drafts remain recoverable.
export class WorkspaceController {
  readonly workspace: WorkspaceDrafts;
  readonly placementSaves: PlacementSaves;
  readonly submission: Submission<Prepared<SubmitRun>>;
  readonly pendingRuns: RequestJournal<Prepared<SubmitRun>>;
  readonly spawnRequests: RequestJournal<Prepared<SpawnArtifact>>;
  private spawns = new Map<string, Submission<Prepared<SpawnArtifact>>>();
  private client: Client;
  private textSaves: TextSaves;
  readonly document: WorkspaceDocument;
  private get serverState() {
    return this.document.base;
  }
  private listeners = new Set<() => void>();
  private revision = 0;
  private epoch = 0;
  private active = false;
  private refreshGeneration = 0;
  private estimateGeneration = 0;
  private lineageGeneration = 0;
  private inspectionGeneration = 0;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private estimateTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private cleanups: (() => void)[] = [];
  private streamRevision = 0;
  private streamed = new Map<string, { revision: number; text: string }>();
  private delivering = new Set<string>();
  error = '';
  notice = '';
  models = ['mock'];
  vision: Capabilities = {};
  budget?: Budget;
  estimate?: Estimate;
  lineage: ConversationMessage[] = [];
  inspected?: Inspection;
  busy = false;
  spawning: string[] = [];
  constructor(
    readonly actor: string | undefined,
    readonly braneId: string,
    private deps: WorkspaceDependencies,
  ) {
    this.client = createClient(deps.request);
    this.workspace = new WorkspaceDrafts(actor, braneId, deps.storage);
    this.placementSaves = new PlacementSaves({
      write: (id, geometry, version) => this.client.savePlacement(id, { ...geometry, version }),
      read: (id) => this.client.placement(id),
    });
    this.textSaves = new TextSaves(this.client.saveText);
    this.document = new WorkspaceDocument((p) => this.placementSaves.project(p));
    this.pendingRuns = new RequestJournal(
      JSON.stringify(['mem-brane-pending-runs', actor, braneId]),
      (v) => validPrepared(v, submitRun),
      deps.storage,
    );
    this.spawnRequests = new RequestJournal(
      JSON.stringify(['mem-brane-pending-spawns', actor, braneId]),
      (v) => validPrepared(v, spawnArtifact),
      deps.storage,
    );
    this.submission = new Submission(this.pendingRuns);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private emit = () => {
    if (!this.active) return;
    this.document.activity(this.spawning, this.retrySpawns);
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  private valid(epoch: number) {
    return this.active && epoch === this.epoch && this.deps.drafts.getState().actor === this.actor;
  }
  private requireActive() {
    if (!this.valid(this.epoch)) throw new Error('Workspace is closed');
  }
  get state() {
    return this.document.store.getState().state;
  }
  get draft() {
    return this.workspace.draft;
  }
  get retrySpawns() {
    return [...this.spawnRequests.keys()];
  }
  get importTasks() {
    return this.deps.imports.list(this.braneId);
  }
  get pendingAttachments() {
    return this.importTasks.some(
      (t) =>
        t.intent.target === 'composer' &&
        !(t.status === 'ready' && t.delivered) &&
        t.status !== 'rejected',
    );
  }
  get compatibilityError() {
    return (this.draft.references ?? [])
      .map((id) => this.serverState?.blocks.find((b) => b.id === id))
      .flatMap((b) =>
        b
          ? [
              modelCompatibility(
                b.content,
                this.vision[this.draft.model ?? 'mock']?.vision ?? false,
              ),
            ]
          : [],
      )
      .find(Boolean);
  }
  get hasPending() {
    return (
      Object.keys(this.deps.drafts.getState().drafts).length > 0 || this.placementSaves.hasPending()
    );
  }
  setError = (error: string) => {
    this.error = error;
    this.emit();
  };
  private report = (error: unknown) => {
    this.setError(error instanceof Error ? error.message : 'Workspace operation failed');
  };
  private background(work: Promise<unknown>) {
    const epoch = this.epoch;
    void work.catch((e) => {
      if (this.valid(epoch)) this.report(e);
    });
  }
  start() {
    if (this.active) return;
    this.active = true;
    const epoch = ++this.epoch;
    let previousDrafts = this.deps.drafts.getState().draftRecords;
    this.cleanups.push(
      this.placementSaves.subscribe(() => {
        this.document.reproject();
        this.emit();
      }),
      this.deps.drafts.subscribe(() => {
        const next = this.deps.drafts.getState().draftRecords;
        if (next === previousDrafts) return;
        previousDrafts = next;
        this.scheduleEstimate();
        this.emit();
      }),
      this.deps.imports.subscribe(() => {
        this.deliverImports();
        this.emit();
      }),
    );
    const reconcile = () => this.background(this.refresh());
    const onRun = (event: Event) => this.onRun((event as CustomEvent).detail);
    const before = (event: Event) => {
      if (this.hasPending) event.preventDefault();
    };
    for (const [name, handler] of [
      ['brane:reconcile', reconcile],
      ['brane:local-change', reconcile],
      ['brane:run', onRun],
      ['beforeunload', before],
    ] as const) {
      this.deps.events.addEventListener(name, handler);
      this.cleanups.push(() => this.deps.events.removeEventListener(name, handler));
    }
    this.poll = setInterval(() => {
      if (this.serverState?.blocks.some((b) => b.content.status === 'pending')) reconcile();
    }, 2000);
    this.background(this.refresh());
    this.background(
      this.client.configuration().then((config) => {
        if (!this.valid(epoch)) return;
        this.models = config.models;
        this.budget = config.budget;
        this.vision = config.modelCapabilities;
        this.deps.imports.maxBytes = config.imports.maxBytes;
        if (!this.draft.model) this.updateDraft({ model: config.defaultModel });
        this.emit();
      }),
    );
    this.scheduleEstimate();
    this.loadLineage();
    this.deliverImports();
    this.emit();
  }
  dispose() {
    this.active = false;
    ++this.epoch;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.estimateTimer);
    clearInterval(this.poll);
    this.delivering.clear();
  }
  updateDraft = (patch: Partial<WorkspaceDraft>) => {
    this.requireActive();
    const previous = this.draft.continueFrom;
    this.workspace.update(patch);
    this.scheduleEstimate();
    if (previous !== this.draft.continueFrom) this.loadLineage();
    this.emit();
  };
  addReferences = (ids: string[]) =>
    this.updateDraft({ references: [...new Set([...(this.draft.references ?? []), ...ids])] });
  setReferences = (references: string[]) => this.updateDraft({ references });
  setContinue = (continueFrom?: string) => this.updateDraft({ continueFrom });
  private applyState(state: BraneState) {
    this.placementSaves.observe(state.placements);
    this.document.install(this.textSaves.reconcile(state));
    this.emit();
  }
  refresh = async () => {
    this.requireActive();
    const epoch = this.epoch,
      generation = ++this.refreshGeneration,
      streamRevision = this.streamRevision;
    void this.client
      .budget()
      .then((budget) => {
        if (this.valid(epoch) && generation === this.refreshGeneration) {
          this.budget = budget;
          this.emit();
        }
      })
      .catch(() => {});
    let next: BraneState;
    try {
      next = await this.client.workspace(this.braneId);
    } catch (error) {
      if (this.valid(epoch) && generation === this.refreshGeneration) throw error;
      return;
    }
    if (!this.valid(epoch) || generation !== this.refreshGeneration) return;
    next.runs = next.runs.map((run) => {
      const stream = this.streamed.get(run.id);
      return stream &&
        stream.revision > streamRevision &&
        ['queued', 'claimed', 'running', 'cancel_requested'].includes(run.status)
        ? { ...run, partial: stream.text }
        : run;
    });
    this.applyState(next);
  };
  private scheduleEstimate() {
    clearTimeout(this.estimateTimer);
    const generation = ++this.estimateGeneration,
      epoch = this.epoch;
    this.estimate = undefined;
    if (!this.valid(epoch) || !this.draft.prompt?.trim()) return;
    this.estimateTimer = setTimeout(() => {
      const request = this.runRequest();
      void this.client
        .estimate(request)
        .then((estimate) => {
          if (this.valid(epoch) && generation === this.estimateGeneration) {
            this.estimate = estimate;
            this.emit();
          }
        })
        .catch(() => {});
    }, 400);
  }
  private loadLineage() {
    const generation = ++this.lineageGeneration,
      epoch = this.epoch;
    this.lineage = [];
    if (!this.draft.continueFrom) return;
    void this.client
      .lineage(this.draft.continueFrom)
      .then((lineage) => {
        if (this.valid(epoch) && generation === this.lineageGeneration) {
          this.lineage = lineage;
          this.emit();
        }
      })
      .catch((error) => {
        if (this.valid(epoch) && generation === this.lineageGeneration) this.report(error);
      });
  }
  onRun = (data: Omit<RunEvent, 'type'>) => {
    if (
      !this.valid(this.epoch) ||
      (data.braneId !== this.braneId && !this.serverState?.runs.some((r) => r.id === data.runId))
    )
      return;
    if (data.status) this.background(this.refresh());
    else if (data.text !== undefined && this.serverState) {
      this.streamed.set(data.runId, { revision: ++this.streamRevision, text: data.text });
      this.document.install({
        ...this.serverState,
        runs: this.serverState.runs.map((r) =>
          r.id === data.runId ? { ...r, partial: data.text! } : r,
        ),
      });
    }
  };
  private deliverImports() {
    const ready = this.importTasks.filter(
      (t) => t.status === 'ready' && !t.delivered && !this.delivering.has(t.id),
    );
    if (!ready.length) return;
    const epoch = this.epoch;
    ready.forEach((t) => this.delivering.add(t.id));
    this.background(
      this.refresh()
        .then(async () => {
          if (!this.valid(epoch)) return;
          for (const task of ready) {
            if (task.intent.target === 'composer' && task.result)
              this.addReferences([task.result.blockId]);
            await this.deps.imports.delivered(task.id);
            if (!this.valid(epoch)) return;
          }
        })
        .finally(() => {
          if (this.valid(epoch)) ready.forEach((t) => this.delivering.delete(t.id));
        }),
    );
  }
  acceptFiles = (
    files: File[],
    target: 'canvas' | 'composer',
    point: { x: number; y: number },
    findSpace = false,
  ) => {
    this.requireActive();
    const at = { ...point };
    if (findSpace) {
      const occupied = [
        ...(this.state?.placements ?? []),
        ...this.importTasks.filter((t) => t.status !== 'rejected').map((t) => t.intent.geometry),
      ];
      const width = Math.min(3, files.length) * 350,
        height = Math.ceil(files.length / 3) * 330;
      for (
        let n = 0;
        n < 500 &&
        occupied.some(
          (g) =>
            at.x < g.x + g.width + 20 &&
            at.x + width > g.x &&
            at.y < g.y + g.height + 20 &&
            at.y + height > g.y,
        );
        n++
      )
        at.y += 330;
    }
    this.background(
      this.deps.imports.enqueue(files, {
        braneId: this.braneId,
        target,
        geometry: { ...at, width: 320, height: 300 },
      }),
    );
  };
  private clearTimer(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  edit = (id: string, text: string) => {
    this.requireActive();
    const block = this.serverState?.blocks.find((b) => b.id === id);
    if (!block) return;
    this.deps.drafts.getState().draft(id, text, block.version, block.content.text);
    this.clearTimer(id);
    this.timers.set(
      id,
      setTimeout(() => this.background(this.saveBlock(id)), 650),
    );
  };
  refreshDrafts = () => {
    this.requireActive();
    return this.deps.drafts.getState().refreshDrafts();
  };
  discardDraft = (draft: Draft) => {
    this.requireActive();
    return this.deps.drafts.getState().discardDraft(draft);
  };
  recoverDraft = (draft: Draft) => {
    this.requireActive();
    this.clearTimer(draft.blockId);
    this.deps.drafts.getState().recoverDraft(draft);
  };
  useServerText = (id: string) => {
    this.requireActive();
    this.clearTimer(id);
    const d = this.deps.drafts.getState();
    const draft = d.draftRecords[id];
    if (draft) d.clearDraft(id, draft.text);
    this.setError('');
  };
  overwriteDraft = async (id: string) => {
    this.requireActive();
    const block = this.serverState?.blocks.find((b) => b.id === id);
    if (!block) return;
    this.deps.drafts.getState().rebase(id, block.version, block.content.text);
    await this.saveBlock(id);
    this.setError('');
  };
  private acknowledge(receipt: EditReceipt, key?: string) {
    this.textSaves.acknowledge(receipt.blockId, receipt);
    if (this.serverState) this.document.install(this.textSaves.reconcile(this.serverState));
    const d = this.deps.drafts.getState(),
      current = d.draftRecords[receipt.blockId];
    if (current && current.key === key && current.baseVersion <= receipt.version) {
      d.clearDraft(receipt.blockId, receipt.content.text);
      if (d.draftRecords[receipt.blockId])
        this.deps.drafts.getState().rebase(receipt.blockId, receipt.version, receipt.content.text);
    }
    this.emit();
  }
  saveBlock = (id: string) => {
    this.requireActive();
    this.clearTimer(id);
    const epoch = this.epoch;
    return this.textSaves.serialize(async () => {
      if (!this.valid(epoch)) return;
      const d = this.deps.drafts.getState(),
        draft = d.draftRecords[id];
      const block = this.serverState?.blocks.find((b) => b.id === id);
      if (!draft || !block) return;
      const disposition = draftDisposition(draft, block);
      if (disposition === 'saved') {
        d.clearDraft(id, draft.text);
        return;
      }
      if (disposition === 'conflict')
        throw new Error('Resolve the changed block below before saving or running.');
      await d.flushRecovery().catch(() => {});
      if (!this.valid(epoch)) return;
      try {
        const saved = await this.textSaves.save({
          blockId: id,
          text: draft.text,
          version: draft.baseVersion,
        });
        if (this.valid(epoch)) this.acknowledge({ blockId: id, ...saved }, draft.key);
      } catch (error) {
        if (this.valid(epoch) && error instanceof ApiError && error.status === 409)
          await this.refresh();
        throw error;
      }
    });
  };
  flush = async () => {
    for (const block of this.serverState?.blocks ?? []) await this.saveBlock(block.id);
    await this.textSaves.flush();
  };
  saveGeometry = (id: string, geometry: Geometry) => {
    this.requireActive();
    const placement = this.state?.placements.find((p) => p.id === id);
    if (!placement) return Promise.reject(new Error('Placement no longer exists.'));
    return this.placementSaves.save(placement, geometry);
  };
  geometry = (id: string, geometry: Geometry) => {
    void this.saveGeometry(id, geometry).catch(() => {});
  };
  save = async () => {
    this.requireActive();
    const epoch = this.epoch,
      title = this.draft.title ?? this.serverState!.brane.title;
    try {
      await this.placementSaves.flush();
      if (!this.valid(epoch)) return;
      await this.flush();
      if (!this.valid(epoch)) return;
      await this.client.saveTitle(this.braneId, title);
      if (!this.valid(epoch)) return;
      await this.refresh();
      if (!this.valid(epoch)) return;
      if (this.draft.title === title) this.updateDraft({ title: undefined });
      this.notice = 'Brane saved on this device';
      this.emit();
    } catch (e) {
      if (this.valid(epoch)) this.report(e);
    }
  };
  private edits(ids: string[], validate = true): Edit[] {
    const drafts = this.deps.drafts.getState().draftRecords;
    return [...new Set(ids)].flatMap((id) => {
      const draft = drafts[id],
        block = this.serverState?.blocks.find((b) => b.id === id);
      if (
        !block ||
        block.origin !== 'authored' ||
        !['text', 'webpage'].includes(block.content.format) ||
        block.content.status === 'pending'
      )
        return [];
      if (!draft) return [{ blockId: id, text: block.content.text, version: block.version }];
      const disposition = draftDisposition(draft, block);
      if (validate && disposition === 'conflict')
        throw new Error('Resolve the changed source before running.');
      return [
        {
          blockId: id,
          text: draft.text,
          version: disposition === 'saved' ? block.version : draft.baseVersion,
        },
      ];
    });
  }
  private runRequest(validate = false, composer = this.draft): SubmitRun {
    return {
      braneId: this.braneId,
      key: crypto.randomUUID(),
      model: composer.model ?? 'mock',
      prompt: composer.prompt ?? '',
      references: [...(composer.references ?? [])],
      continueFrom: composer.continueFrom,
      edits: this.edits(composer.references ?? [], validate),
    };
  }
  private async send<T extends SubmitRun | SpawnArtifact>(
    submission: Submission<Prepared<T>>,
    prepare: () => T,
    transport: (request: T) => Promise<SubmissionReceipt>,
  ) {
    const epoch = this.epoch;
    // Submission and ordinary writes share one lane, including preparation and acknowledgement.
    return this.textSaves.serialize(async () => {
      if (!this.valid(epoch)) throw new Error('Workspace is closed');
      const accepted = await submission.send(
        async () => ({
          payload: prepare(),
          draftKeys: Object.fromEntries(
            Object.values(this.deps.drafts.getState().draftRecords).map((d) => [d.blockId, d.key]),
          ),
        }),
        async (request) => {
          const receipt = await transport(request.payload);
          if (
            receipt.edits.length !== request.payload.edits.length ||
            receipt.edits.some((saved, index) => {
              const edit = request.payload.edits[index];
              return (
                saved.blockId !== edit.blockId ||
                saved.content.text !== edit.text ||
                (saved.version !== edit.version && saved.version !== edit.version + 1)
              );
            })
          )
            throw new Error('Invalid submission acknowledgement; retry the original request.');
          return receipt;
        },
      );
      if (this.valid(epoch))
        for (const receipt of accepted.receipt.edits)
          this.acknowledge(receipt, accepted.request.draftKeys[receipt.blockId]);
      return accepted;
    });
  }
  run = async () => {
    this.requireActive();
    if (
      this.busy ||
      (this.submission.state.status !== 'uncertain' &&
        (this.pendingAttachments || this.compatibilityError))
    )
      return;
    const epoch = this.epoch;
    const composer = structuredClone(this.draft);
    this.busy = true;
    this.setError('');
    try {
      const accepted = await this.send(
        this.submission,
        () => this.runRequest(true, composer),
        this.client.submit,
      );
      if (!this.valid(epoch)) return;
      if (this.draft.prompt === accepted.request.payload.prompt) this.updateDraft({ prompt: '' });
      this.notice = 'Run submitted · context frozen';
      await this.refresh();
    } catch (e) {
      if (this.valid(epoch)) {
        this.report(e);
        if (e instanceof ApiError && e.status === 409) this.background(this.refresh());
      }
    } finally {
      if (this.valid(epoch)) {
        this.busy = false;
        this.emit();
      }
    }
  };
  spawn = async (blockId: string, placementId: string) => {
    this.requireActive();
    if (this.spawning.includes(blockId)) return;
    const epoch = this.epoch;
    const model = this.draft.model ?? 'mock';
    this.spawning = [...this.spawning, blockId];
    this.clearTimer(blockId);
    this.setError('');
    let submission = this.spawns.get(blockId);
    if (!submission) {
      submission = new Submission(this.spawnRequests, blockId);
      this.spawns.set(blockId, submission);
    }
    try {
      const accepted = await this.send(
        submission,
        () => ({
          braneId: this.braneId,
          key: crypto.randomUUID(),
          sourceBlockIds: [blockId],
          anchorPlacementId: placementId,
          action: 'develop',
          model,
          edits: this.edits([blockId]),
        }),
        this.client.spawn,
      );
      if (!this.valid(epoch)) return;
      this.notice = 'Artifact spawned · source context frozen';
      await this.refresh();
      if (!this.valid(epoch)) return;
      return accepted.receipt.outputBlockId;
    } catch (e) {
      if (this.valid(epoch)) {
        this.report(e);
        if (e instanceof ApiError && e.status === 409) this.background(this.refresh());
      }
    } finally {
      if (this.valid(epoch)) {
        this.spawning = this.spawning.filter((id) => id !== blockId);
        this.emit();
      }
    }
  };
  create = async (geometry = { x: 100, y: 100, width: 320, height: 220 }) => {
    this.requireActive();
    const epoch = this.epoch;
    try {
      const block = await this.client.createText(this.braneId, geometry);
      if (!this.valid(epoch)) return;
      await this.refresh();
      if (this.valid(epoch)) return block.id;
    } catch (e) {
      if (this.valid(epoch)) this.report(e);
    }
  };
  previewRevision = async (id: string) => {
    this.requireActive();
    const epoch = this.epoch;
    const revision = await this.client.revision(id);
    if (this.valid(epoch)) {
      this.notice = revision.content.text.slice(0, 180);
      this.emit();
    }
  };
  inspect = async (id?: string) => {
    this.requireActive();
    const epoch = this.epoch,
      generation = ++this.inspectionGeneration;
    this.inspected = undefined;
    this.emit();
    if (!id) return;
    const inspected = await this.client.run(id);
    if (this.valid(epoch) && generation === this.inspectionGeneration) {
      this.inspected = inspected;
      this.emit();
    }
  };
  importWebpage = (url: string) => this.mutate(() => this.client.importWebpage(this.braneId, url));
  cancelRun = (id: string) => this.mutate(() => this.client.cancelRun(id));
  retryRun = (id: string) => this.mutate(() => this.client.retryRun(id, crypto.randomUUID()));
  private mutate = async (work: () => Promise<unknown>) => {
    this.requireActive();
    const epoch = this.epoch;
    await work();
    if (this.valid(epoch)) await this.refresh();
  };
}

function validPrepared(
  value: unknown,
  schema: { safeParse(value: unknown): { success: boolean } },
): boolean {
  if (!value || typeof value !== 'object' || !('payload' in value) || !('draftKeys' in value))
    return false;
  return (
    schema.safeParse(value.payload).success &&
    !!value.draftKeys &&
    typeof value.draftKeys === 'object' &&
    !Array.isArray(value.draftKeys) &&
    Object.values(value.draftKeys).every((key) => typeof key === 'string')
  );
}
