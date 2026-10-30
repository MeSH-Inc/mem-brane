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
  Revision,
} from '../../shared/types/domain';
import type { ConversationMessage } from '../../shared/types/conversation';
import { submitRun, spawnArtifact } from '../../shared/schemas';
import { modelCompatibility } from '../../shared/representations';
import { api, ApiError } from './api';
import { PlacementSaves } from './placement-saves';
import { TextSaves } from './text-saves';
import { WorkspaceDocument } from './workspace-document';
import { Submission } from './submission';
import { CommandTasks, type CommandProgress } from './command-tasks';
import { RequestJournal } from './request-journal';
import { WorkspaceDrafts, type WorkspaceDraft, type WorkspaceStorage } from './workspace-drafts';
import { draftDisposition, type Draft } from './drafts';
import type { Interaction } from '../stores/interaction';
import type { Imports } from './imports';
import { estimateIssue, runIssueOf, type RunIssue } from './run-issues';
import { runMachine as runMachineSchema, type RunMachine } from '../../shared/machines';
import { machineStaleness, openSpot } from '../canvas/machines';

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
  readonly commands = new CommandTasks();
  readonly workspace: WorkspaceDrafts;
  readonly placementSaves: PlacementSaves;
  readonly submission: Submission<Prepared<SubmitRun>>;
  readonly pendingRuns: RequestJournal<Prepared<SubmitRun>>;
  readonly spawnRequests: RequestJournal<Prepared<SpawnArtifact>>;
  readonly retryRequests: RequestJournal<string>;
  readonly machineRequests: RequestJournal<Prepared<RunMachine>>;
  private machines = new Map<string, Submission<Prepared<RunMachine>>>();
  private spawns = new Map<string, Submission<Prepared<SpawnArtifact>>>();
  private retries = new Map<string, Submission<string>>();
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
  private previewGeneration = 0;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private estimateTimer?: ReturnType<typeof setTimeout>;
  private titleTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private cleanups: (() => void)[] = [];
  private streamRevision = 0;
  private streamed = new Map<string, { revision: number; text: string }>();
  private delivering = new Set<string>();
  error = '';
  // A Run refusal belongs beside the Run button, not in the workspace banner.
  runFailure?: RunIssue;
  titleError = '';
  previewed?: Revision;
  models = ['mock'];
  vision: Capabilities = {};
  budget?: Budget;
  estimate?: Estimate;
  private estimateError?: unknown;
  lineage: ConversationMessage[] = [];
  inspected?: Inspection;
  get busy() {
    return this.commands.pending('run');
  }
  get spawning() {
    return this.commands
      .activeKeys()
      .filter((key) => key.startsWith('spawn:'))
      .map((key) => key.slice(6));
  }

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
    this.machineRequests = new RequestJournal(
      JSON.stringify(['mem-brane-pending-machine-runs', actor, braneId]),
      (v) => validPrepared(v, runMachineSchema),
      deps.storage,
    );
    this.retryRequests = new RequestJournal(
      JSON.stringify(['mem-brane-pending-retries', actor, braneId]),
      (v) => typeof v === 'string',
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
    this.document.activity(this.spawning, this.retrySpawns, this.commands.store.getState());
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
  // The estimate is advisory except when it proves the server will refuse the Run.
  get estimateIssue() {
    return estimateIssue(this.draft.model ?? 'mock', this.estimate, this.estimateError);
  }
  get hasPending() {
    return (
      this.commands.activeKeys().length > 0 ||
      this.draft.title !== undefined ||
      Object.keys(this.deps.drafts.getState().drafts).length > 0 ||
      this.placementSaves.hasPending()
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
      this.commands.store.subscribe(this.emit),
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
        if (!this.draft.model || !config.models.includes(this.draft.model))
          this.updateDraft({ model: config.defaultModel });
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
    clearTimeout(this.titleTimer);
    clearInterval(this.poll);
    this.delivering.clear();
  }
  updateDraft = (patch: Partial<WorkspaceDraft>) => {
    this.requireActive();
    const previous = this.draft.continueFrom;
    this.workspace.update(patch);
    if ('title' in patch) {
      this.titleError = '';
      this.scheduleTitleSave();
    }
    if (['prompt', 'model', 'references', 'continueFrom'].some((key) => key in patch)) {
      this.runFailure = undefined;
      this.scheduleEstimate();
    }
    if (previous !== this.draft.continueFrom) this.loadLineage();
    this.emit();
  };
  addReferences = (ids: string[]) =>
    this.updateDraft({ references: [...new Set([...(this.draft.references ?? []), ...ids])] });
  setReferences = (references: string[]) => this.updateDraft({ references });
  setContinue = (continueFrom?: string) => this.updateDraft({ continueFrom });
  private applyState(state: BraneState) {
    const initial = !this.serverState;
    this.placementSaves.observe(state.placements);
    this.document.install(this.textSaves.reconcile(state));
    if (initial) this.scheduleTitleSave();
    this.emit();
  }
  private scheduleTitleSave() {
    clearTimeout(this.titleTimer);
    if (this.draft.title === undefined || !this.serverState) return;
    this.titleTimer = setTimeout(() => void this.saveTitle(), 650);
  }
  // Serialize title writes and drain newer edits before clearing the recoverable draft.
  // Replica admission persists each write locally before it is synchronized remotely.
  saveTitle = (): Promise<void> => {
    this.requireActive();
    clearTimeout(this.titleTimer);
    if (this.draft.title === undefined || !this.serverState) return Promise.resolve();
    const epoch = this.epoch;
    this.titleError = '';
    return this.commands
      .run('title', async () => {
        while (this.valid(epoch) && this.draft.title !== undefined) {
          const title = this.draft.title;
          if (!title.trim()) throw new Error('Enter a title.');
          if (title !== this.serverState!.brane.title) {
            await this.client.saveTitle(this.braneId, title);
            if (!this.valid(epoch)) return;
            await this.refresh();
            if (!this.valid(epoch)) return;
          }
          if (this.draft.title === title) this.updateDraft({ title: undefined });
        }
      })
      .catch((error) => {
        if (this.valid(epoch)) {
          this.titleError = error instanceof Error ? error.message : 'Could not save the title';
          this.emit();
        }
      });
  };
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
    this.estimateError = undefined;
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
        .catch((error) => {
          if (this.valid(epoch) && generation === this.estimateGeneration) {
            this.estimateError = error;
            this.emit();
          }
        });
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
  overwriteDraft = (id: string) =>
    this.command(`saveDraft:${id}`, async () => {
      const block = this.serverState?.blocks.find((b) => b.id === id);
      if (!block) return;
      this.deps.drafts.getState().rebase(id, block.version, block.content.text);
      await this.saveBlock(id);
    });
  saveDraft = (id: string) => this.command(`saveDraft:${id}`, () => this.saveBlock(id));
  private acknowledge(receipt: EditReceipt, key?: string, expectedVersion?: number) {
    this.textSaves.acknowledge(receipt.blockId, receipt, expectedVersion);
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
    const d = this.deps.drafts.getState(),
      draft = d.draftRecords[id];
    const block = this.serverState?.blocks.find((b) => b.id === id);
    if (!draft || !block) return Promise.resolve();
    const disposition = draftDisposition(draft, block);
    if (disposition === 'saved') {
      d.clearDraft(id, draft.text);
      return Promise.resolve();
    }
    if (disposition === 'conflict')
      return Promise.reject(new Error('Resolve the changed block below before saving or running.'));
    const captured = structuredClone(draft);
    return this.textSaves.serialize([id], async () => {
      const current = () =>
        this.valid(epoch) && this.deps.drafts.getState().draftRecords[id]?.key === captured.key;
      if (!current()) return;
      await d.flushRecovery().catch(() => {});
      if (!current()) return;
      const edit = this.textSaves.afterOwnWrites({
        blockId: id,
        text: captured.text,
        version: captured.baseVersion,
      });
      try {
        const saved = await this.textSaves.save(edit);
        if (this.valid(epoch)) this.acknowledge({ blockId: id, ...saved }, captured.key);
      } catch (error) {
        if (this.valid(epoch) && error instanceof ApiError && error.status === 409)
          await this.refresh();
        throw error;
      }
    });
  };
  flush = async () => {
    await Promise.all((this.serverState?.blocks ?? []).map((block) => this.saveBlock(block.id)));
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
  private async send<T extends SubmitRun | SpawnArtifact | RunMachine>(
    submission: Submission<Prepared<T>>,
    prepare: () => T,
    transport: (request: T) => Promise<SubmissionReceipt>,
    progress: CommandProgress,
  ) {
    const epoch = this.epoch;
    const captured: Prepared<T> | undefined =
      submission.state.status === 'uncertain'
        ? undefined
        : {
            payload: structuredClone(prepare()),
            draftKeys: Object.fromEntries(
              Object.values(this.deps.drafts.getState().draftRecords).map((d) => [
                d.blockId,
                d.key,
              ]),
            ),
          };
    const payload =
      captured?.payload ??
      (submission.state.status === 'uncertain' ? submission.state.request.payload : undefined)!;
    // Capture values before yielding and reserve their lanes now. Later typing
    // joins behind this snapshot; unrelated blocks have independent lanes.
    progress('waiting');
    return this.textSaves.serialize(
      payload.edits.map((edit) => edit.blockId),
      async () => {
        if (!this.valid(epoch)) throw new Error('Workspace is closed');
        progress('working');
        const accepted = await submission.send(
          async () => ({
            ...captured!,
            payload: {
              ...captured!.payload,
              edits: captured!.payload.edits.map((edit) => this.textSaves.afterOwnWrites(edit)),
            },
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
            this.acknowledge(
              receipt,
              accepted.request.draftKeys[receipt.blockId],
              accepted.request.payload.edits.find((edit) => edit.blockId === receipt.blockId)
                ?.version,
            );
        return accepted;
      },
    );
  }
  run = async () => {
    this.requireActive();
    if (
      this.busy ||
      (this.submission.state.status !== 'uncertain' &&
        (this.pendingAttachments || this.compatibilityError || this.estimateIssue?.blocking))
    )
      return;
    this.runFailure = undefined;
    return this.command(
      'run',
      async (progress) => {
        const epoch = this.epoch,
          composer = structuredClone(this.draft);
        const accepted = await this.send(
          this.submission,
          () => this.runRequest(true, composer),
          this.client.submit,
          progress,
        );
        if (!this.valid(epoch)) return;
        if (this.draft.prompt === accepted.request.payload.prompt) this.updateDraft({ prompt: '' });
        progress('refreshing');
        await this.refresh();
        if (this.valid(epoch)) return accepted.receipt.outputBlockId;
      },
      (error) => {
        this.runFailure = runIssueOf(error);
        this.emit();
      },
    ).catch(() => {});
  };
  spawn = async (blockId: string, placementId: string) => {
    this.requireActive();
    if (this.spawning.includes(blockId)) return;
    return this.command(`spawn:${blockId}`, async (progress) => {
      const epoch = this.epoch,
        model = this.draft.model ?? 'mock';
      this.clearTimer(blockId);
      let submission = this.spawns.get(blockId);
      if (!submission) {
        submission = new Submission(this.spawnRequests, blockId);
        this.spawns.set(blockId, submission);
      }
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
        progress,
      );
      if (!this.valid(epoch)) return;
      progress('refreshing');
      await this.refresh();
      if (this.valid(epoch)) return accepted.receipt.outputBlockId;
    }).catch(() => undefined);
  };
  // The run names the machine's current feeds explicitly and freezes them with any
  // unsaved edits to the template or the fed cards.
  private machineRequest(placementId: string): RunMachine {
    const state = this.state;
    const placement = state?.placements.find((p) => p.id === placementId);
    if (!state || !placement) throw new Error('This machine is no longer on the brane.');
    const draft = this.deps.drafts.getState().draftRecords[placement.block_id]?.text;
    const view = machineStaleness(state, placementId, draft);
    if (!view.slots.length) throw new Error('Name at least one {slot} in the machine prompt.');
    if (view.missingSlots.length) throw new Error(`Feed the {${view.missingSlots[0]}} slot first.`);
    const inputs = view.inputs.map(({ blockId, slot }) => ({ blockId, slot }));
    return {
      braneId: this.braneId,
      key: crypto.randomUUID(),
      machinePlacementId: placementId,
      model: this.draft.model ?? 'mock',
      inputs,
      edits: this.edits([placement.block_id, ...inputs.map((i) => i.blockId)]),
    };
  }
  estimateMachine = (placementId: string) => {
    this.requireActive();
    return this.client.estimateMachine({ ...this.machineRequest(placementId), edits: [] });
  };
  runMachine = (placementId: string) => {
    this.requireActive();
    return this.command(`machine:${placementId}`, async (progress) => {
      const epoch = this.epoch;
      let submission = this.machines.get(placementId);
      if (!submission) {
        submission = new Submission(this.machineRequests, placementId);
        this.machines.set(placementId, submission);
      }
      const accepted = await this.send(
        submission,
        () => this.machineRequest(placementId),
        this.client.runMachine,
        progress,
      );
      if (!this.valid(epoch)) return;
      progress('refreshing');
      await this.refresh();
      if (this.valid(epoch)) return accepted.receipt.outputBlockId;
    }).catch(() => undefined);
  };
  createMachine = (geometry: Geometry) =>
    this.command(`createMachine:${JSON.stringify(geometry)}`, async (progress) => {
      const epoch = this.epoch;
      const block = await this.client.createMachine(this.braneId, geometry);
      if (!this.valid(epoch)) return;
      progress('refreshing');
      await this.refresh();
      if (this.valid(epoch)) return block.id;
    }).catch(() => undefined);
  // Feeding never runs anything; it records which cards a machine's slot takes.
  feed = (fromPlacementIds: string[], toPlacementId: string, slot: string) =>
    this.mutate(`feed:${toPlacementId}:${slot}:${fromPlacementIds.join(',')}`, async () => {
      const state = this.state;
      const machine = state?.placements.find((p) => p.id === toPlacementId);
      if (!state || !machine) throw new Error('This machine is no longer on the brane.');
      const kinds = new Map(state.blocks.map((b) => [b.id, b.kind]));
      const existing = new Set(
        state.feeds
          .filter((f) => f.to_placement_id === toPlacementId && f.slot === slot)
          .map((f) => f.from_placement_id),
      );
      const sources = state.placements.filter(
        (p) =>
          fromPlacementIds.includes(p.id) &&
          !existing.has(p.id) &&
          kinds.get(p.block_id) !== 'machine',
      );
      if (!sources.length) throw new Error('Select one or more cards to feed this slot.');
      for (const source of sources)
        await this.client.createFeed({
          braneId: this.braneId,
          fromPlacementId: source.id,
          toPlacementId,
          slot,
        });
    }).catch(() => undefined);
  // Put a card from its host's back onto the table, in the first open space beside
  // the host, so it can be moved, fed and linked like any other card.
  detach = (placementId: string) =>
    this.mutate(`detach:${placementId}`, async () => {
      const state = this.state;
      const placement = state?.placements.find((p) => p.id === placementId);
      const host = placement && state?.placements.find((p) => p.id === placement.host_placement_id);
      if (!state || !placement || !host) throw new Error('This card is no longer on a back.');
      const geometry = openSpot(
        state.placements.filter((p) => !p.host_placement_id),
        { x: host.x + host.width + 40, y: host.y },
        placement.width,
        placement.height,
      );
      await this.client.detachPlacement(placementId, placement.version, geometry);
    }).catch(() => undefined);
  unfeed = (feedId: string) =>
    this.mutate(`unfeed:${feedId}`, () => this.client.removeFeed(feedId)).catch(() => undefined);
  create = (geometry?: Geometry) => {
    const captured = structuredClone(geometry ?? { x: 100, y: 100, width: 320, height: 220 });
    // Toolbar creation shares a key; separate canvas rectangles are separate intents.
    const key = geometry ? `create:${JSON.stringify(captured)}` : 'create';
    return this.command(key, async (progress) => {
      const epoch = this.epoch;
      const block = await this.client.createText(this.braneId, captured);
      if (!this.valid(epoch)) return;
      progress('refreshing');
      await this.refresh();
      if (this.valid(epoch)) return block.id;
    }).catch(() => undefined);
  };
  previewRevision = async (id?: string) => {
    this.requireActive();
    const epoch = this.epoch,
      generation = ++this.previewGeneration;
    this.previewed = undefined;
    this.emit();
    if (!id) return;
    const revision = await this.client.revision(id);
    if (this.valid(epoch) && generation === this.previewGeneration) {
      this.previewed = revision;
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
  // Load a composed run's prompt, its current reference cards and the branch it continued
  // into the composer. Submitting stays an explicit Run; nothing regenerates here.
  reuseInputs = async (runId: string) => {
    this.requireActive();
    const epoch = this.epoch;
    const detail = await this.client.run(runId);
    if (!this.valid(epoch)) return;
    const present = new Set(this.state?.blocks.map((b) => b.id));
    const sources = (this.state?.derivations ?? [])
      .filter((d) => d.runId === runId && d.kind === 'reference')
      .sort((a, b) => a.position - b.position);
    const inputs = detail.inputs.filter((input) => input.kind === 'reference');
    if (sources.length !== inputs.length)
      throw new Error(
        'Show this response on the brane before reusing its sources. Your prompt was kept.',
      );
    const missing = sources.flatMap((source, index) =>
      present.has(source.sourceBlockId) ? [] : [index + 1],
    );
    if (missing.length)
      throw new Error(
        `${missing.length === 1 ? 'Source' : 'Sources'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no longer on this brane. Restore unplaced cards or show them here from their other brane, then reuse inputs. Your prompt was kept.`,
      );
    const references = sources.map((source) => source.sourceBlockId);
    const prompt = detail.inputs.find((input) => input.kind === 'prompt')?.content.text ?? '';
    this.updateDraft({ prompt, references, continueFrom: detail.continue_from ?? undefined });
  };
  importWebpage = (url: string) =>
    this.mutate('webpage', () => this.client.importWebpage(this.braneId, url));
  cancelRun = (id: string) => this.mutate(`cancel:${id}`, () => this.client.cancelRun(id));
  // A retry is a paid run. An uncertain acknowledgement reuses its journaled key,
  // so a second activation reconciles the first instead of creating another run.
  retryRun = (id: string) =>
    this.mutate(`retry:${id}`, async () => {
      let submission = this.retries.get(id);
      if (!submission) {
        submission = new Submission(this.retryRequests, `retry:${id}`);
        this.retries.set(id, submission);
      }
      await submission.send(
        async () => crypto.randomUUID(),
        (key) => this.client.retryRun(id, key),
      );
    });
  private mutate = (key: string, work: () => Promise<unknown>) =>
    this.command(key, async (progress) => {
      const epoch = this.epoch;
      await work();
      if (!this.valid(epoch)) return;
      progress('refreshing');
      await this.refresh();
    });
  private command<T>(
    key: string,
    work: (progress: CommandProgress) => Promise<T>,
    report: (error: unknown) => void = this.report,
  ): Promise<T> {
    this.requireActive();
    const epoch = this.epoch;
    return this.commands.run(key, async (progress) => {
      this.setError('');
      try {
        return await work(progress);
      } catch (error) {
        if (this.valid(epoch)) {
          report(error);
          if (error instanceof ApiError && error.status === 409) this.background(this.refresh());
        }
        throw error;
      }
    });
  }
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
