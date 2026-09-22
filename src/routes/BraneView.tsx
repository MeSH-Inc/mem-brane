import { ActionMenu } from '../components/ActionMenu';
import { Dialog } from '../components/Dialog';
import { RunActivity } from '../components/RunActivity';
import { CommandButton } from '../components/CommandButton';
import { localAsset } from '../services/local-assets';
import { client } from '../services/client';
import { LocalImage } from '../components/LocalAsset';
import { SavedDrafts } from '../components/SavedDrafts';
import { WorkspaceController } from '../services/workspace';
import { PdfContent } from '../components/PdfContent';
import { imports } from '../services/imports';
import { acceptedFiles, pasteFiles, dropFiles, allowFileDrop } from '../services/import-adapters';
import { ImportTray } from '../components/ImportTray';
import { selectedBlockIds } from '../canvas/selection';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  lazy,
  Suspense,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Geometry } from '../../shared/types/domain';
import { api, replica, needsAccount } from '../services/api';
import { useInteraction } from '../stores/interaction';
import { presentationFor } from '../stores/presentation';
import { useStore } from 'zustand';
import { LiveBlockContent } from '../components/LiveBlockContent';
import { SpawnButton } from '../components/SpawnButton';
import { ArtifactActions, type CardAction } from '../components/ArtifactActions';
import { ResponseSources } from '../components/ResponseSources';
import { RunHistory } from '../components/RunHistory';
import { draftDisposition } from '../services/drafts';
import { useMobile } from '../lib/useMobile';
import { formatUsd } from '../lib/format';
import { cardKind, statusLabels } from '../lib/labels';
const BraneCanvas = lazy(() =>
  import('../canvas/BraneCanvas').then((module) => ({ default: module.BraneCanvas })),
);

const cardActionLabels: Record<CardAction, string> = {
  place: 'Show on another brane…',
  versions: 'Version history',
  remove: 'Remove from this brane',
};

type BraneViewProps = { braneId: string; focus?: string; view?: 'canvas' | 'focus' };

export function BraneView(props: BraneViewProps) {
  const actor = useInteraction((s) => s.actor);
  const [reset, setReset] = useState(0);
  useEffect(() => {
    const changed = () => setReset((n) => n + 1);
    window.addEventListener('brane:replica-reset', changed);
    return () => window.removeEventListener('brane:replica-reset', changed);
  }, []);
  return <BraneWorkspace key={JSON.stringify([actor, props.braneId, reset])} {...props} />;
}

function BraneWorkspace({ braneId, focus, view }: BraneViewProps) {
  const actor = useInteraction((s) => s.actor);
  const presentation = presentationFor(actor, braneId);
  const retainedFocus = useStore(presentation, (s) => s.focus);
  const focusRequest = useStore(presentation, (s) => s.request);

  const [controller] = useState(
    () =>
      new WorkspaceController(actor, braneId, {
        request: api,
        storage: sessionStorage,
        drafts: useInteraction,
        imports,
        events: window,
      }),
  );
  useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    useInteraction.getState().setSelectedPlacements(presentation.getState().selection);
    const unsubscribe = useInteraction.subscribe((next, previous) => {
      if (next.selectedPlacements !== previous.selectedPlacements)
        presentation.getState().remember({ selection: next.selectedPlacements });
    });
    controller.start();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);
  const {
    state,
    workspace,
    error,
    models,
    busy,
    inspected,
    estimate,
    lineage,
    budget,
    vision,
    placementSaves,
    pendingRuns,
    spawnRequests,
    submission,
    spawning,
    retrySpawns,
    importTasks,
    pendingAttachments,
    compatibilityError,
    refresh,
    saveBlock,
    commands,
    saveDraft,
    edit,
    geometry,
    run,
    setError,
  } = controller;
  const sync = useSyncExternalStore(replica.subscribe, replica.getSnapshot);
  const mediaKey = state?.blocks.map((block) => block.content.assetId ?? '').join(',');
  useEffect(() => {
    if (!replica.actor || !state) return;
    for (const block of state.blocks) {
      if (block.content.assetId) void localAsset(block.content.assetId).catch(() => {});
      if (block.content.format === 'pdf' && 'representationId' in block.content)
        void client.pdfPages(block.content.representationId).catch(() => {});
    }
  }, [mediaKey, sync.connected]);
  const placementFailures = placementSaves.failures();
  const {
    prompt = '',
    model = 'mock',
    title: titleDraft,
    references = [],
    continueFrom,
  } = controller.draft;
  const setPrompt = (prompt: string) => controller.updateDraft({ prompt });
  const setModel = (model: string) => controller.updateDraft({ model });
  const setTitleDraft = (title: string) => controller.updateDraft({ title });
  const [inspectorTab, setInspectorTab] = useState<'context' | 'history'>('context');
  const [webOpen, setWebOpen] = useState(false),
    [url, setUrl] = useState(''),
    [managed, setManaged] = useState<{ blockId: string; placementId?: string; view: CardAction }>();
  const mobile = useMobile();
  const focusMode = view === 'focus' || (!view && mobile);
  const ui = {
    addReferences: controller.addReferences,
    references,
    continueFrom,
    setReferences: controller.setReferences,
    setContinue: controller.setContinue,
    draftRecords: useInteraction((s) => s.draftRecords),
    drafts: useInteraction((s) => s.drafts),
    inspector: useInteraction((s) => s.inspector),
    recovered: useInteraction((s) => s.recovered),
    availableDrafts: useInteraction((s) => s.availableDrafts),
    refreshDrafts: controller.refreshDrafts,
    discardDraft: controller.discardDraft,
    recoveryError: useInteraction((s) => s.recoveryError),
    selectedPlacements: useInteraction((s) => s.selectedPlacements),
    setInspector: useInteraction((s) => s.setInspector),
  };
  // Selection never changes context by itself; the composer offers to add it.
  const unreferencedSelection = selectedBlockIds(
    state?.placements ?? [],
    ui.selectedPlacements,
  ).filter((id) => !references.includes(id));
  const navigate = useNavigate();
  const focusBlock = useCallback(
    (id: string) => {
      useInteraction.getState().setInspector(false);
      presentation.getState().remember({ focus: id });
      void navigate({
        to: '/b/$braneId',
        params: { braneId },
        search: { focus: id, view: 'focus' },
      });
    },
    [braneId, navigate, presentation],
  );
  const create = useCallback(
    async (geometry?: Geometry) => {
      const attention = presentation.getState().attention;
      const id = await controller.create(geometry);
      if (!id) return;
      const placementId = controller.state?.placements.find((p) => p.block_id === id)?.id;
      if (presentation.getState().reveal(attention, { blockId: id, placementId, kind: 'edit' })) {
        if (placementId) useInteraction.getState().setSelectedPlacements([placementId]);
        if (focusMode || mobile) focusBlock(id);
      }
    },
    [controller, mobile, focusMode, focusBlock, presentation],
  );
  const spawn = useCallback(
    (blockId: string, placementId: string) => {
      if (needsAccount()) return;
      const attention = presentation.getState().attention;
      const retrying = controller.retrySpawns.includes(blockId);
      void controller.spawn(blockId, placementId).then((id) => {
        // Reconcile an earlier delivery without reopening its already-created output.
        if (retrying) return;
        if (
          id &&
          presentation.getState().reveal(attention, { blockId: id, kind: 'reveal' }) &&
          (focusMode || mobile)
        ) {
          focusBlock(id);
          const request = presentation.getState().request;
          if (request) presentation.getState().consume(request.id);
        }
      });
    },
    [controller, mobile, focusMode, focusBlock, presentation],
  );
  const inspectRun = useCallback(
    (runId: string) => {
      setInspectorTab('history');
      useInteraction.getState().setInspector(true);
      void controller.inspect(runId).catch((e) => controller.setError(e.message));
    },
    [controller],
  );
  const rerun = useCallback(
    (runId: string) => {
      const derivation = controller.state?.derivations.find((d) => d.runId === runId);
      if (!derivation) return;
      if (derivation.kind === 'source') {
        const placement = controller.state?.placements.find(
          (p) => p.block_id === derivation.sourceBlockId,
        );
        if (placement) spawn(derivation.sourceBlockId, placement.id);
      } else
        void controller
          .reuseInputs(runId)
          .then(() =>
            document.querySelector<HTMLTextAreaElement>('[aria-label="Run prompt"]')?.focus(),
          )
          .catch((e) => controller.setError(e.message));
    },
    [controller, spawn],
  );
  const manage = useCallback(
    (blockId: string, placementId: string, view: CardAction) =>
      setManaged({ blockId, placementId, view }),
    [],
  );
  const continueBranch = useCallback(
    (messageId?: string) => {
      controller.setContinue(messageId);
      if (messageId)
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('[aria-label="Run prompt"]')?.focus(),
        );
    },
    [controller],
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const insertionReady = useCallback((getPoint: () => { x: number; y: number }) => {
    canvasInsertion.current = getPoint;
  }, []);
  const pickerTarget = useRef<'canvas' | 'composer'>('canvas');
  const canvasInsertion = useRef<() => { x: number; y: number }>(() => ({ x: 100, y: 100 }));
  const acceptFiles = useCallback(
    (files: File[], target: 'canvas' | 'composer', point?: { x: number; y: number }) => {
      controller.acceptFiles(files, target, point ?? canvasInsertion.current(), !point);
    },
    [controller],
  );
  const attachFiles = useCallback(
    (files: File[], point?: { x: number; y: number }) => acceptFiles(files, 'canvas', point),
    [acceptFiles],
  );
  const focused = state?.blocks.find((b) => b.id === (focus ?? retainedFocus)) ?? state?.blocks[0];
  if (!state) return <div className="loading">{error || 'Opening brane…'}</div>;
  const availableDrafts = ui.availableDrafts.filter((d) =>
    state.blocks.some((b) => b.id === d.blockId),
  );
  return (
    <div
      className="brane-workspace"
      onPointerDownCapture={presentation.getState().interact}
      onKeyDownCapture={presentation.getState().interact}
      onWheelCapture={presentation.getState().interact}
    >
      <div className="brane-toolbar">
        <div>
          <input
            aria-label="Brane title"
            className="brane-title"
            maxLength={200}
            value={titleDraft ?? state.brane.title}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void controller.saveTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          {controller.titleError && (
            <div className="title-error" role="alert">
              Title not saved: {controller.titleError}
              <button onClick={() => void controller.saveTitle()}>Retry title save</button>
            </div>
          )}
        </div>
        <div className="toolbar-actions">
          <ActionMenu label="＋ Add">
            <CommandButton
              tasks={commands}
              taskKey="create"
              pendingLabel="Creating…"
              onClick={() => void create()}
            >
              ＋ Text
            </CommandButton>
            <button
              onClick={() => {
                pickerTarget.current = 'canvas';
                fileInput.current?.click();
              }}
            >
              ▧ Image / PDF
            </button>
            <button onClick={() => setWebOpen(!webOpen)}>↗ Webpage</button>
          </ActionMenu>
          <div className="view-toggle">
            <button
              className={!focusMode ? 'active' : ''}
              onClick={() =>
                void navigate({
                  to: '/b/$braneId',
                  params: { braneId },
                  search: { view: 'canvas', focus: focused?.id },
                })
              }
            >
              Canvas
            </button>
            <button
              className={focusMode ? 'active' : ''}
              onClick={() =>
                void navigate({
                  to: '/b/$braneId',
                  params: { braneId },
                  search: { view: 'focus', focus: focused?.id },
                })
              }
            >
              Focus
            </button>
          </div>
          <button
            onClick={(event) => {
              event.currentTarget.focus();
              setInspectorTab('history');
              ui.setInspector(true);
            }}
          >
            History
          </button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={acceptedFiles}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          acceptFiles(files, pickerTarget.current);
        }}
      />
      {ui.recoveryError && (
        <div role="alert" className="error-banner">
          {ui.recoveryError}
        </div>
      )}
      <SavedDrafts
        drafts={availableDrafts}
        blocks={state.blocks}
        onRefresh={ui.refreshDrafts}
        onDiscard={ui.discardDraft}
        onRecover={controller.recoverDraft}
      />
      {state.blocks
        .filter(
          (b) =>
            ui.draftRecords[b.id] &&
            (ui.recovered.includes(b.id) ||
              draftDisposition(ui.draftRecords[b.id], b) === 'conflict'),
        )
        .map((b) => {
          const draft = ui.draftRecords[b.id],
            conflict = draftDisposition(draft, b) === 'conflict';
          return (
            <div className="draft-recovery" key={b.id}>
              <strong>
                {conflict ? 'This block changed elsewhere' : 'Unsaved draft recovered or pending'}
              </strong>
              <p>{draft.text.slice(0, 140)}</p>
              {conflict && (
                <details>
                  <summary>Compare original, my draft and server text</summary>
                  <h4>Original text (version {draft.baseVersion})</h4>
                  <pre>{draft.baseText}</pre>
                  <h4>My draft</h4>
                  <pre>{draft.text}</pre>
                  <h4>Server text (version {b.version})</h4>
                  <pre>{b.content.text}</pre>
                </details>
              )}
              <button
                onClick={() => {
                  controller.useServerText(b.id);
                  setError('');
                }}
              >
                Use server text
              </button>
              <CommandButton
                tasks={commands}
                taskKey={`saveDraft:${b.id}`}
                pendingLabel="Saving…"
                onClick={async () => {
                  try {
                    if (conflict) await controller.overwriteDraft(b.id);
                    else await saveDraft(b.id);
                    setError('');
                  } catch (e) {
                    setError((e as Error).message);
                    await refresh();
                  }
                }}
              >
                {conflict ? 'Overwrite with my draft' : 'Save draft'}
              </CommandButton>
            </div>
          );
        })}
      {placementFailures.map((failure) => (
        <div className="error-banner" role="alert" key={failure.id}>
          <span>
            Placement changes are unsaved. {failure.message} Your latest move is still shown.
          </span>
          <button disabled={failure.busy} onClick={() => void placementSaves.retry(failure.id)}>
            Save my latest placement
          </button>
          <button disabled={failure.busy} onClick={() => void placementSaves.discard(failure.id)}>
            Use saved placement
          </button>
        </div>
      ))}
      {managed && state.blocks.some((b) => b.id === managed.blockId) && (
        <ArtifactActions
          key={`${managed.blockId}:${managed.view}`}
          view={managed.view}
          commands={commands}
          block={state.blocks.find((b) => b.id === managed.blockId)!}
          placementId={managed.placementId}
          braneId={braneId}
          onSave={() => saveBlock(managed.blockId)}
          onChange={refresh}
          onClose={() => setManaged(undefined)}
        />
      )}
      <div className="workbench">
        <div
          className="workspace"
          onPaste={(event) => pasteFiles(event, attachFiles)}
          onDragOver={allowFileDrop}
          onDrop={(event) => dropFiles(event, attachFiles)}
        >
          {!focusMode && (
            <div className="tools">
              <span className="canvas-hint">
                Double-click to write · Drag to select · Space-drag to pan
              </span>
            </div>
          )}
          {webOpen && (
            <form
              className="web-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (needsAccount()) return;
                try {
                  await controller.importWebpage(url);
                  setWebOpen(false);
                  setUrl('');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <input
                type="url"
                required
                placeholder="https://…"
                aria-label="Webpage URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <CommandButton tasks={commands} taskKey="webpage" pendingLabel="Importing…">
                Import webpage
              </CommandButton>
            </form>
          )}
          {(error ||
            workspace.error ||
            pendingRuns.error ||
            spawnRequests.error ||
            submission.state.status === 'uncertain') && (
            <div role="alert" className="error-banner">
              {error || workspace.error || pendingRuns.error || spawnRequests.error}
              <button
                onClick={() => {
                  setError('');
                  void refresh();
                }}
              >
                Reload state
              </button>
              {submission.state.status === 'uncertain' && (
                <p>
                  Delivery is uncertain. Retry submission checks the original request; edits to the
                  composer are kept for your next run.
                </p>
              )}
            </div>
          )}
          {retrySpawns.length > 0 && (
            <p>
              Develop delivery is uncertain. Retry Develop checks the original request, including
              its original source edits.
            </p>
          )}
          {importTasks.length > 0 && <ImportTray tasks={importTasks} />}
          {imports.recoveryError && (
            <p role="alert" className="error">
              {imports.recoveryError}
            </p>
          )}
          <RunActivity controller={controller} onOpen={focusBlock} />
          {focusMode ? (
            <div className="focus-layout">
              <nav className="block-outline">
                <span className="eyebrow">CARDS / {state.blocks.length}</span>
                {state.blocks.map((b, i) => (
                  <button
                    key={b.id}
                    className={focused?.id === b.id ? 'active' : ''}
                    onClick={() => focusBlock(b.id)}
                  >
                    {String(i + 1).padStart(2, '0')}{' '}
                    <span>
                      {b.origin === 'generated' && '✳ '}
                      {b.content.text.slice(0, 38) || cardKind(b)}
                    </span>
                  </button>
                ))}
              </nav>
              {focused ? (
                <article className="focus-card">
                  <span className="eyebrow">{cardKind(focused)}</span>
                  <LiveBlockContent
                    key={focused.id}
                    document={controller.document}
                    blockId={focused.id}
                    focusRequest={
                      focusRequest?.kind === 'edit' && focused.id === focusRequest.blockId
                        ? focusRequest.id
                        : undefined
                    }
                    onFocused={presentation.getState().consume}
                    onEdit={edit}
                  />
                  {focused.origin === 'generated' && (
                    <ResponseSources
                      document={controller.document}
                      blockId={focused.id}
                      onOpenSource={focusBlock}
                      onInspect={inspectRun}
                      onRerun={rerun}
                    />
                  )}
                  <footer>
                    <SpawnButton
                      block={focused}
                      busy={spawning.includes(focused.id)}
                      phase={commands.store.getState()[`spawn:${focused.id}`]?.phase}
                      retry={retrySpawns.includes(focused.id)}
                      onSpawn={() => {
                        const placement = state.placements.find((p) => p.block_id === focused.id);
                        if (placement) spawn(focused.id, placement.id);
                      }}
                    />
                    {focused.messageId ? (
                      <button onClick={() => continueBranch(focused.messageId)}>⑂ Continue</button>
                    ) : (
                      <button onClick={() => ui.addReferences([focused.id])}>
                        + Use as context
                      </button>
                    )}
                    <ActionMenu label="More" align="right">
                      {focused.messageId && (
                        <button onClick={() => ui.addReferences([focused.id])}>
                          + Use as context
                        </button>
                      )}
                      {(['place', 'versions', 'remove'] as const).map((view) => (
                        <button
                          key={view}
                          onClick={() =>
                            setManaged({
                              blockId: focused.id,
                              placementId: state.placements.find((p) => p.block_id === focused.id)
                                ?.id,
                              view,
                            })
                          }
                        >
                          {cardActionLabels[view]}
                        </button>
                      ))}
                    </ActionMenu>
                  </footer>
                </article>
              ) : (
                <div className="empty-focus">
                  <h2>Every idea starts somewhere.</h2>
                  <CommandButton
                    tasks={commands}
                    taskKey="create"
                    pendingLabel="Creating…"
                    onClick={() => void create()}
                  >
                    Add your first thought
                  </CommandButton>
                </div>
              )}
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="canvas-host" role="status">
                  Loading canvas…
                </div>
              }
            >
              {!state.blocks.length && (
                <div className="canvas-empty">
                  <h2>Start with a thought</h2>
                  <CommandButton
                    tasks={commands}
                    taskKey="create"
                    pendingLabel="Creating…"
                    onClick={() => void create()}
                  >
                    Add your first thought
                  </CommandButton>
                  <p>Or double-click anywhere, or drop an image or PDF here.</p>
                </div>
              )}
              <BraneCanvas
                onContext={controller.addReferences}
                onContinue={continueBranch}
                onImport={attachFiles}
                onInsertionReady={insertionReady}
                document={controller.document}
                onSpawn={spawn}
                onCreate={create}
                onEdit={edit}
                onGeometry={geometry}
                onFocus={focusBlock}
                onManage={manage}
                onInspect={inspectRun}
                onRerun={rerun}
              />
            </Suspense>
          )}
          <div className="composer">
            <div className="context-chips">
              <button
                className="context-toggle"
                onClick={(event) => {
                  event.currentTarget.focus();
                  setInspectorTab('context');
                  ui.setInspector(true);
                }}
              >
                Context · {ui.references.length}
                {ui.continueFrom ? ' + branch' : ''}
              </button>
              {ui.continueFrom && (
                <button className="chip branch" onClick={() => ui.setContinue(undefined)}>
                  ⑂ Continuing a branch ×
                </button>
              )}
              {ui.references.map((id, i) => (
                <button
                  key={id}
                  className="chip"
                  onClick={() => ui.setReferences(ui.references.filter((x) => x !== id))}
                >
                  {i + 1} ·{' '}
                  {state.blocks.find((b) => b.id === id)?.content.text.slice(0, 23) || 'Card'} ×
                </button>
              ))}
              {!focusMode && unreferencedSelection.length > 0 && (
                <button
                  className="suggest-chip"
                  onClick={() => ui.addReferences(unreferencedSelection)}
                >
                  + Add {unreferencedSelection.length} selected
                </button>
              )}
              {!ui.references.length && !ui.continueFrom && (
                <span className="muted">Prompt only</span>
              )}
            </div>
            <div
              className="prompt-row"
              onPaste={(event) => pasteFiles(event, (files) => acceptFiles(files, 'composer'))}
              onDragOver={allowFileDrop}
              onDrop={(event) => dropFiles(event, (files) => acceptFiles(files, 'composer'))}
            >
              <button
                aria-label="Attach files to prompt"
                onClick={() => {
                  pickerTarget.current = 'composer';
                  fileInput.current?.click();
                }}
              >
                ＋
              </button>
              <textarea
                aria-label="Run prompt"
                placeholder="Where should this thought go next?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (
                      (prompt.trim() || submission.state.status === 'uncertain') &&
                      !needsAccount()
                    )
                      void run();
                  }
                }}
              />
              <button
                className="primary run-button"
                disabled={
                  busy ||
                  (submission.state.status !== 'uncertain' &&
                    (pendingAttachments || !!compatibilityError || !prompt.trim()))
                }
                onClick={() => {
                  if (!needsAccount()) void run();
                }}
              >
                {busy
                  ? commands.store.getState().run?.phase === 'waiting'
                    ? 'Waiting for sources…'
                    : 'Submitting…'
                  : submission.state.status === 'uncertain'
                    ? 'Retry submission ↗'
                    : 'Run ↗'}
              </button>
            </div>
            {pendingAttachments && (
              <small>Finish or dismiss failed attachments before running.</small>
            )}
            {compatibilityError && (
              <p role="alert" className="error">
                {compatibilityError}
              </p>
            )}
            <div className="composer-meta">
              <ActionMenu label={model === 'mock' ? 'Local mock' : model} className="model-menu">
                <label>
                  Model
                  <select
                    aria-label="Model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <p>
                  {model === 'mock'
                    ? 'Local mock · no model spend'
                    : `Daily budget remaining: ${formatUsd(budget?.availableMicrousd ?? 0)}`}
                </p>
                <p>
                  {vision[model]?.vision
                    ? 'Image + PDF text context'
                    : 'Text-only model · PDF text supported'}
                </p>
              </ActionMenu>
              {estimate && model !== 'mock' && (
                <span>
                  {estimate.canAfford ? 'Up to' : 'Exceeds budget:'}{' '}
                  {formatUsd(estimate.reservedMicrousd)}
                </span>
              )}
              <span className="save-notice" role="status">
                {controller.titleError ||
                placementFailures.length ||
                Object.keys(ui.draftRecords).some((id) => {
                  const block = state.blocks.find((block) => block.id === id);
                  return block && draftDisposition(ui.draftRecords[id], block) === 'conflict';
                })
                  ? 'Changes need attention'
                  : titleDraft !== undefined ||
                      Object.keys(ui.drafts).length ||
                      placementSaves.hasPending() ||
                      commands.pending('title')
                    ? 'Saving…'
                    : sync.pending
                      ? 'Saved on device · Syncing…'
                      : 'Saved'}
              </span>
            </div>
          </div>
        </div>
        {ui.inspector && (
          <Dialog
            title={inspectorTab === 'context' ? 'Context' : 'History'}
            onClose={() => ui.setInspector(false)}
          >
            <aside className="inspector">
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {inspectorTab === 'context' && (
                <>
                  <div className="section-label">
                    NEXT RUN <span>{ui.references.length} references</span>
                  </div>
                  {ui.continueFrom && (
                    <div className="lineage-note">
                      ⑂ Continuing a branch ({lineage.length} earlier messages)
                      <ol>
                        {lineage.map((m) => (
                          <li key={m.id}>
                            <button
                              onClick={() => {
                                const block = state.blocks.find((b) => b.id === m.block_id);
                                if (block) focusBlock(block.id);
                                else
                                  void controller
                                    .previewRevision(m.revision_id)
                                    .catch((e) => setError(e.message));
                              }}
                            >
                              {m.role}: {m.content.text.slice(0, 55)}
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {controller.previewed && (
                    <section className="revision-preview">
                      <div className="section-label">
                        Earlier version{' '}
                        <button onClick={() => void controller.previewRevision()}>Close</button>
                      </div>
                      <pre>{controller.previewed.content.text}</pre>
                      {controller.previewed.content.format === 'pdf' && (
                        <PdfContent content={controller.previewed.content} showProvenance />
                      )}
                      {controller.previewed.content.format === 'image' && (
                        <LocalImage
                          className="context-image"
                          assetId={controller.previewed.content.assetId!}
                          alt="Earlier version"
                        />
                      )}
                    </section>
                  )}
                  {ui.references.length ? (
                    ui.references.map((id, i) => (
                      <div className="context-item" key={id}>
                        <span className="context-number">{i + 1}</span>
                        <div>
                          <strong>
                            {(() => {
                              const block = state.blocks.find((b) => b.id === id);
                              return block ? cardKind(block) : 'Card';
                            })()}
                          </strong>
                          <p>
                            {(
                              ui.drafts[id] ??
                              state.blocks.find((b) => b.id === id)?.content.text ??
                              ''
                            ).slice(0, 100) || 'Empty card'}
                          </p>
                        </div>
                        <div className="order-actions">
                          <button
                            aria-label="Move reference up"
                            disabled={i === 0}
                            onClick={() => {
                              const ids = [...ui.references];
                              [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                              ui.setReferences(ids);
                            }}
                          >
                            ↑
                          </button>
                          <button
                            aria-label="Remove reference"
                            onClick={() => ui.setReferences(ui.references.filter((x) => x !== id))}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="inspector-empty">
                      <span>◇</span>
                      <p>
                        Choose “Use as context” on a card, or select cards, to include them in your
                        next prompt.
                      </p>
                    </div>
                  )}
                </>
              )}
              {inspected && (
                <div className="frozen-inspector">
                  <div className="section-label">
                    EXACT INPUTS{' '}
                    <button
                      aria-label="Close exact inputs"
                      onClick={() => void controller.inspect()}
                    >
                      ×
                    </button>
                  </div>
                  {inspected.cost && (
                    <p className="cost-detail">
                      {inspected.cost.status === 'confirmed'
                        ? `Cost: ${formatUsd(inspected.cost.confirmed_microusd ?? 0)}`
                        : `Cost not yet confirmed · up to ${formatUsd(inspected.cost.reserved_microusd)} held`}
                    </p>
                  )}
                  {inspected.inputs.map((input) => (
                    <details key={input.position} open>
                      <summary>
                        {input.position + 1} · {input.label}
                      </summary>
                      <code>{input.revision_id}</code>
                      <pre>{input.content.text}</pre>
                      {input.content.format === 'pdf' && (
                        <PdfContent content={input.content} showProvenance />
                      )}
                      {input.content.format === 'image' && (
                        <>
                          <LocalImage
                            className="context-image"
                            assetId={input.content.assetId!}
                            alt="Submitted image"
                          />
                          <small>
                            Frozen image · low detail · SHA-256 {input.content.assetHash}
                          </small>
                        </>
                      )}
                    </details>
                  ))}
                </div>
              )}
              {inspectorTab === 'history' && (
                <>
                  <div className="section-label">
                    RESPONSES <span>{state.runs.length}</span>
                  </div>
                  <div className="run-list">
                    {[...state.runs].reverse().map((r) => {
                      const text = state.blocks
                        .find((b) => b.id === r.output_block_id)
                        ?.content.text.trim();
                      return (
                        <div className="run-item" key={r.id}>
                          <button
                            className="run-inspect"
                            title="Show exact inputs"
                            onClick={() =>
                              void controller.inspect(r.id).catch((e) => setError(e.message))
                            }
                          >
                            <span className={`status-dot ${r.status}`} />
                            <div>
                              <strong>{text?.slice(0, 60) || 'Response'}</strong>
                              <small>
                                {new Date(r.created_at).toLocaleString()} · {r.model} ·{' '}
                                {statusLabels[r.status] ?? r.status}
                                {r.retry_of ? ' · retry' : ''}
                              </small>
                            </div>
                            <span>Inputs</span>
                          </button>
                          {['queued', 'claimed', 'running', 'cancel_requested'].includes(
                            r.status,
                          ) && (
                            <CommandButton
                              tasks={commands}
                              taskKey={`cancel:${r.id}`}
                              pendingLabel="Stopping…"
                              disabled={r.status === 'cancel_requested'}
                              onClick={() => void controller.cancelRun(r.id).catch(() => {})}
                            >
                              {r.status === 'cancel_requested' ? 'Stopping…' : 'Stop'}
                            </CommandButton>
                          )}
                          {['failed', 'interrupted', 'cancelled'].includes(r.status) && (
                            <CommandButton
                              tasks={commands}
                              taskKey={`retry:${r.id}`}
                              pendingLabel="Retrying…"
                              onClick={async () => {
                                try {
                                  await controller.retryRun(r.id);
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              }}
                            >
                              Retry with the same inputs
                            </CommandButton>
                          )}
                          {r.error && <small className="error">{r.error}</small>}
                          <button onClick={() => focusBlock(r.output_block_id)}>Open</button>
                        </div>
                      );
                    })}
                  </div>
                  <RunHistory
                    key={braneId}
                    braneId={braneId}
                    exclude={state.runs.map((r) => r.id)}
                    onInspect={async (id) => {
                      await controller.inspect(id);
                    }}
                  />
                </>
              )}
            </aside>
          </Dialog>
        )}
      </div>
    </div>
  );
}
