import { SavedDrafts } from '../components/SavedDrafts';
import { WorkspaceController } from '../services/workspace';
import { PdfContent } from '../components/PdfContent';
import { imports } from '../services/imports';
import { acceptedFiles, pasteFiles, dropFiles, allowFileDrop } from '../services/import-adapters';
import { ImportTray } from '../components/ImportTray';
import { canvasTools } from '../canvas/tools';
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
import { api } from '../services/api';
import { useInteraction } from '../stores/interaction';
import { BlockContent } from '../components/BlockContent';
import { SpawnButton } from '../components/SpawnButton';
import { ArtifactActions } from '../components/ArtifactActions';
import { RunHistory } from '../components/RunHistory';
import { draftDisposition } from '../services/drafts';
import { useMobile } from '../lib/useMobile';
const BraneCanvas = lazy(() =>
  import('../canvas/BraneCanvas').then((module) => ({ default: module.BraneCanvas })),
);

type BraneViewProps = { braneId: string; focus?: string; view?: 'canvas' | 'focus' };

export function BraneView(props: BraneViewProps) {
  const actor = useInteraction((s) => s.actor);
  return <BraneWorkspace key={JSON.stringify([actor, props.braneId])} {...props} />;
}

function BraneWorkspace({ braneId, focus, view }: BraneViewProps) {
  const actor = useInteraction((s) => s.actor);
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
    useInteraction.setState({ selectedPlacements: [] });
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  const {
    state,
    workspace,
    error,
    notice,
    newBlock,
    revealedBlock,
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
    edit,
    saveGeometry,
    geometry,
    save,
    run,
    setError,
  } = controller;
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
  const [webOpen, setWebOpen] = useState(false),
    [url, setUrl] = useState(''),
    [managed, setManaged] = useState<string>();
  const mobile = useMobile();
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
    setTool: useInteraction((s) => s.setTool),
    tool: useInteraction((s) => s.tool),
  };
  const selectedBlocks = selectedBlockIds(state?.placements ?? [], ui.selectedPlacements);
  const navigate = useNavigate();
  const focusBlock = useCallback(
    (id: string) => {
      void navigate({
        to: '/b/$braneId',
        params: { braneId },
        search: { focus: id, view: 'focus' },
      });
    },
    [braneId, navigate],
  );
  const create = useCallback(
    async (geometry?: Geometry) => {
      const id = await controller.create(geometry);
      if (id && mobile) focusBlock(id);
    },
    [controller, mobile, focusBlock],
  );
  const spawn = useCallback(
    (blockId: string, placementId: string) => {
      void controller.spawn(blockId, placementId).then((id) => {
        if (id && mobile) focusBlock(id);
      });
    },
    [controller, mobile, focusBlock],
  );
  const fileInput = useRef<HTMLInputElement>(null);
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
  const focusMode = view === 'focus' || (!view && mobile);
  const focused = state?.blocks.find((b) => b.id === focus) ?? state?.blocks[0];
  if (!state) return <div className="loading">{error || 'Opening brane…'}</div>;
  const availableDrafts = ui.availableDrafts.filter((d) =>
    state.blocks.some((b) => b.id === d.blockId),
  );
  return (
    <>
      <div className="brane-toolbar">
        <div>
          <span className="eyebrow">YOUR THINKING SPACE</span>
          <input
            aria-label="Brane title"
            className="brane-title"
            value={titleDraft ?? state.brane.title}
            onChange={(e) => setTitleDraft(e.target.value)}
          />
          {titleDraft !== undefined && titleDraft !== state.brane.title && (
            <small className="muted">Unsaved title · choose Save brane to publish this edit</small>
          )}
        </div>
        <div className="toolbar-actions">
          <div className="view-toggle">
            <button
              className={!focusMode ? 'active' : ''}
              onClick={() =>
                void navigate({
                  to: '/b/$braneId',
                  params: { braneId },
                  search: { view: 'canvas' },
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
          <button onClick={() => void save()}>Save brane</button>
          <button
            className="icon-button"
            title="Context inspector"
            onClick={() => ui.setInspector(!ui.inspector)}
          >
            ☷
          </button>
        </div>
      </div>
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
              <button
                onClick={async () => {
                  try {
                    if (conflict) await controller.overwriteDraft(b.id);
                    else await saveBlock(b.id);
                    setError('');
                  } catch (e) {
                    setError((e as Error).message);
                    await refresh();
                  }
                }}
              >
                {conflict ? 'Overwrite with my draft' : 'Save draft'}
              </button>
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
      {managed && state.blocks.find((b) => b.id === managed) && (
        <ArtifactActions
          key={managed}
          block={state.blocks.find((b) => b.id === managed)!}
          placements={state.placements.filter((p) => p.block_id === managed)}
          onSave={() => saveBlock(managed)}
          onGeometry={saveGeometry}
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
          <div className="tools">
            <div className="canvas-tools" role="group" aria-label="Canvas tools">
              {canvasTools.map(({ id, label }) => (
                <button
                  key={id}
                  className={ui.tool === id ? 'active' : ''}
                  aria-pressed={ui.tool === id}
                  onClick={() => ui.setTool(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="divider" />
            <button onClick={() => void create()}>＋ Text</button>
            <button
              onClick={() => {
                pickerTarget.current = 'canvas';
                fileInput.current?.click();
              }}
            >
              ▧ Image / PDF
            </button>
            <button onClick={() => setWebOpen(!webOpen)}>↗ Webpage</button>
            {selectedBlocks.length > 0 && (
              <button onClick={() => ui.addReferences(selectedBlocks)}>
                Use {selectedBlocks.length} as context
              </button>
            )}
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
          </div>
          {webOpen && (
            <form
              className="web-form"
              onSubmit={async (e) => {
                e.preventDefault();
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
              <button>Import webpage</button>
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
              Spawn delivery is uncertain. Retry Spawn checks the original request, including its
              original source edits.
            </p>
          )}
          {importTasks.length > 0 && <ImportTray tasks={importTasks} />}
          {imports.recoveryError && (
            <p role="alert" className="error">
              {imports.recoveryError}
            </p>
          )}
          {focusMode ? (
            <div className="focus-layout">
              <nav className="block-outline">
                <span className="eyebrow">BLOCKS / {state.blocks.length}</span>
                {state.blocks.map((b, i) => (
                  <button
                    key={b.id}
                    className={focused?.id === b.id ? 'active' : ''}
                    onClick={() => focusBlock(b.id)}
                  >
                    {String(i + 1).padStart(2, '0')}{' '}
                    <span>{b.content.text.slice(0, 38) || b.kind}</span>
                  </button>
                ))}
              </nav>
              {focused ? (
                <article className="focus-card">
                  <span className="eyebrow">{focused.kind}</span>
                  <BlockContent
                    key={focused.id}
                    block={focused}
                    partial={state.runs.find((r) => r.output_block_id === focused.id)?.partial}
                    autoFocus={focused.id === newBlock}
                    onEdit={edit}
                  />
                  <footer>
                    <button onClick={() => setManaged(focused.id)}>Block actions</button>
                    <SpawnButton
                      block={focused}
                      busy={spawning.includes(focused.id)}
                      retry={retrySpawns.includes(focused.id)}
                      onSpawn={() => {
                        const placement = state.placements.find((p) => p.block_id === focused.id);
                        if (placement) spawn(focused.id, placement.id);
                      }}
                    />
                    {state.derivations
                      .filter((d) => d.outputBlockId === focused.id)
                      .map((d) => (
                        <button
                          key={`${d.runId}:${d.position}`}
                          onClick={() => focusBlock(d.sourceBlockId)}
                          disabled={!state.blocks.some((b) => b.id === d.sourceBlockId)}
                        >
                          Spawned from{' '}
                          {state.blocks
                            .find((b) => b.id === d.sourceBlockId)
                            ?.content.text.slice(0, 24) || 'source artifact'}
                        </button>
                      ))}
                    <button onClick={() => ui.addReferences([focused.id])}>+ Use as context</button>
                    {focused.messageId && (
                      <button onClick={() => ui.setContinue(focused.messageId)}>
                        ⑂ Continue from here
                      </button>
                    )}
                  </footer>
                </article>
              ) : (
                <div className="empty-focus">
                  <h2>Every idea starts somewhere.</h2>
                  <button onClick={() => void create()}>Add your first thought</button>
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
              <BraneCanvas
                onContext={controller.addReferences}
                onContinue={controller.setContinue}
                onImport={attachFiles}
                onInsertionReady={(getPoint) => {
                  canvasInsertion.current = getPoint;
                }}
                state={state}
                revealedBlock={revealedBlock}
                onSpawn={spawn}
                spawning={spawning}
                retrySpawns={retrySpawns}
                newBlock={newBlock}
                onCreate={(g) => void create(g)}
                onEdit={edit}
                onGeometry={geometry}
                onFocus={focusBlock}
                onManage={setManaged}
              />
            </Suspense>
          )}
          <div className="composer">
            <div className="context-chips">
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
                  {state.blocks.find((b) => b.id === id)?.content.text.slice(0, 23) || 'Artifact'} ×
                </button>
              ))}
              {!ui.references.length && !ui.continueFrom && (
                <span className="muted">
                  Only your prompt will be sent. Add context explicitly.
                </span>
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
                    if (prompt.trim() || submission.state.status === 'uncertain') void run();
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
                onClick={() => void run()}
              >
                {busy
                  ? 'Submitting…'
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
              <label>
                <span className="model-dot" />
                <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <span>
                {model === 'mock'
                  ? 'Local mock · no model spend'
                  : `Daily budget remaining: $${((budget?.availableMicrousd ?? 0) / 1e6).toFixed(4)}`}
              </span>
              {estimate && (
                <span>
                  {estimate.canAfford ? 'Up to' : 'Exceeds budget:'} $
                  {(estimate.reservedMicrousd / 1e6).toFixed(6)} reserved
                </span>
              )}
              <span>
                {vision[model]?.vision
                  ? 'Image + PDF text context'
                  : 'Text-only model · PDF text supported'}
              </span>
              <span className="save-notice" role="status">
                {Object.keys(ui.drafts).length || placementSaves.hasPending()
                  ? 'Unsaved edits'
                  : notice || 'All thoughts have room here'}
              </span>
            </div>
          </div>
        </div>
        {ui.inspector && (
          <aside className="inspector">
            <div className="inspector-heading">
              <h2>Context, clearly.</h2>
              <span>↗</span>
            </div>
            <p>
              What the model sees is a choice.
              <br />
              Space alone doesn’t make a connection.
            </p>
            <div className="section-label">
              NEXT RUN <span>{ui.references.length} references</span>
            </div>
            {ui.continueFrom && (
              <div className="lineage-note">
                ⑂ Conversation lineage ({lineage.length} messages)
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
            {ui.references.length ? (
              ui.references.map((id, i) => (
                <div className="context-item" key={id}>
                  <span className="context-number">{i + 1}</span>
                  <div>
                    <strong>{state.blocks.find((b) => b.id === id)?.kind ?? 'Artifact'}</strong>
                    <p>
                      {(
                        ui.drafts[id] ??
                        state.blocks.find((b) => b.id === id)?.content.text ??
                        ''
                      ).slice(0, 100) || 'Empty block'}
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
                <p>Choose “Use as context” on a block to bring it into your next exploration.</p>
              </div>
            )}
            <div className="snapshot-note">
              Drafts stay in this tab across reloads. At Run, current reference content becomes an
              immutable snapshot.
            </div>
            <div className="section-label">
              VISIBLE / ACTIVE EXPLORATIONS <span>{state.runs.length}</span>
            </div>
            <div className="run-list">
              {[...state.runs].reverse().map((r, i) => (
                <div className="run-item" key={r.id}>
                  <button
                    className="run-inspect"
                    onClick={() => void controller.inspect(r.id).catch((e) => setError(e.message))}
                  >
                    <span className={`status-dot ${r.status}`} />
                    <div>
                      <strong>Exploration {state.runs.length - i}</strong>
                      <small>
                        {r.model} · {r.status}
                        {r.retry_of ? ' · retry' : ''}
                      </small>
                    </div>
                    <span>↗</span>
                  </button>
                  {['queued', 'claimed', 'running', 'cancel_requested'].includes(r.status) && (
                    <button
                      onClick={async () => {
                        await controller.cancelRun(r.id);
                      }}
                    >
                      Cancel run
                    </button>
                  )}
                  {['failed', 'interrupted', 'cancelled'].includes(r.status) && (
                    <button
                      onClick={async () => {
                        try {
                          await controller.retryRun(r.id);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Retry frozen context
                    </button>
                  )}
                  {r.error && <small className="error">{r.error}</small>}
                  {r.usage_json && <small>Confirmed usage: {r.usage_json}</small>}
                  <button onClick={() => focusBlock(r.output_block_id)}>Open response</button>
                </div>
              ))}
            </div>
            <RunHistory
              key={braneId}
              braneId={braneId}
              onInspect={async (id) => {
                await controller.inspect(id);
              }}
            />
            {inspected && (
              <div className="frozen-inspector">
                <div className="section-label">
                  EXACT SUBMITTED INPUTS{' '}
                  <button onClick={() => void controller.inspect()}>×</button>
                </div>
                {inspected.cost && (
                  <p className="cost-detail">
                    {inspected.cost.status === 'confirmed'
                      ? `Usage-rated: $${((inspected.cost.confirmed_microusd ?? 0) / 1e6).toFixed(6)}`
                      : `${inspected.cost.status}: $${(inspected.cost.reserved_microusd / 1e6).toFixed(6)} reserved (upper estimate)`}
                  </p>
                )}
                {inspected.inputs.map((input) => (
                  <details key={input.position} open>
                    <summary>
                      {input.position + 1}. {input.kind} · {input.label}
                    </summary>
                    <code>{input.revision_id}</code>
                    <pre>{input.content.text}</pre>
                    {input.content.format === 'pdf' && (
                      <PdfContent content={input.content} showProvenance />
                    )}
                    {input.content.format === 'image' && (
                      <>
                        <img
                          className="context-image"
                          src={`/api/assets/${input.content.assetId}`}
                          alt="Submitted image"
                        />
                        <small>Frozen image · low detail · SHA-256 {input.content.assetHash}</small>
                      </>
                    )}
                  </details>
                ))}
              </div>
            )}
            <div className="inspector-bottom">ARRANGE FREELY. THINK DELIBERATELY.</div>
          </aside>
        )}
      </div>
    </>
  );
}
