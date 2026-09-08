import { canvasTools } from '../canvas/tools';
import { selectedBlockIds } from '../canvas/selection';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  lazy,
  Suspense,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import type {
  BraneState,
  RunInput,
  SubmitRun,
  SpawnArtifact,
  Run,
} from '../../shared/types/domain';
import { PlacementSaves } from '../services/placement-saves';
import type { Geometry, Placement } from '../../shared/types/domain';
import { api, ApiError } from '../services/api';
import { useInteraction } from '../stores/interaction';
import { BlockContent } from '../components/BlockContent';
import { SpawnButton } from '../components/SpawnButton';
import { ArtifactActions } from '../components/ArtifactActions';
import { draftDisposition } from '../services/drafts';
import { useMobile } from '../lib/useMobile';
const BraneCanvas = lazy(() =>
  import('../canvas/BraneCanvas').then((module) => ({ default: module.BraneCanvas })),
);

export function BraneView({
  braneId,
  focus,
  view,
}: {
  braneId: string;
  focus?: string;
  view?: 'canvas' | 'focus';
}) {
  const [serverState, setState] = useState<BraneState>();
  const [placementSaves] = useState(
    () =>
      new PlacementSaves({
        write: (id, geometry, version) =>
          api<Placement>(`/placements/${id}`, { ...geometry, version }, 'PATCH'),
        read: (id) => api<Placement>(`/placements/${id}`),
      }),
  );
  const geometryRevision = useSyncExternalStore(
    placementSaves.subscribe,
    placementSaves.getSnapshot,
  );
  const state = useMemo(
    () =>
      serverState
        ? { ...serverState, placements: placementSaves.project(serverState.placements) }
        : undefined,
    [serverState, placementSaves, geometryRevision],
  );
  const placementFailures = placementSaves.failures();
  const stateRef = useRef(state);
  stateRef.current = state;
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [newBlock, setNewBlock] = useState<string>(),
    [revealedBlock, setRevealedBlock] = useState<string>(),
    [prompt, setPrompt] = useState(''),
    [model, setModel] = useState('mock'),
    [models, setModels] = useState<string[]>(['mock']),
    [busy, setBusy] = useState(false),
    [inspected, setInspected] = useState<{
      id: string;
      inputs: RunInput[];
      cost?: { status: string; reserved_microusd: number; confirmed_microusd: number | null };
    }>(),
    [webOpen, setWebOpen] = useState(false),
    [url, setUrl] = useState('');
  const [estimate, setEstimate] = useState<{ reservedMicrousd: number; canAfford: boolean }>();
  const [managed, setManaged] = useState<string>(),
    [lineage, setLineage] = useState<any[]>([]),
    [budget, setBudget] = useState<{ availableMicrousd: number; limitMicrousd: number }>(),
    [vision, setVision] = useState<Record<string, { vision: boolean }>>({});
  const [titleDraft, setTitleDraft] = useState<string>();
  const mobile = useMobile();
  const ui = {
    addReferences: useInteraction((s) => s.addReferences),
    clearDraft: useInteraction((s) => s.clearDraft),
    continueFrom: useInteraction((s) => s.continueFrom),
    draftRecords: useInteraction((s) => s.draftRecords),
    drafts: useInteraction((s) => s.drafts),
    inspector: useInteraction((s) => s.inspector),
    rebase: useInteraction((s) => s.rebase),
    recovered: useInteraction((s) => s.recovered),
    recoveryError: useInteraction((s) => s.recoveryError),
    references: useInteraction((s) => s.references),
    resetContext: useInteraction((s) => s.resetContext),
    selectedPlacements: useInteraction((s) => s.selectedPlacements),
    setContinue: useInteraction((s) => s.setContinue),
    setInspector: useInteraction((s) => s.setInspector),
    setReferences: useInteraction((s) => s.setReferences),
    setTool: useInteraction((s) => s.setTool),
    tool: useInteraction((s) => s.tool),
  };
  const selectedBlocks = selectedBlockIds(state?.placements ?? [], ui.selectedPlacements);
  const navigate = useNavigate();
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef<SubmitRun | null>(null);
  const spawnRequests = useRef(new Map<string, SpawnArtifact>());
  const spawningRef = useRef(new Set<string>());
  const [spawning, setSpawning] = useState<string[]>([]);
  const [retrySpawns, setRetrySpawns] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    void api('/budget')
      .then(setBudget)
      .catch(() => {});
    const next = await api<BraneState>(`/branes/${braneId}`);
    if (generation !== refreshGeneration.current) return;
    placementSaves.observe(next.placements);
    stateRef.current = next;
    setState(next);
  }, [braneId, placementSaves]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    void api('/config').then((c) => {
      setModels(c.models);
      setBudget(c.budget);
      setVision(c.modelCapabilities);
      setModel(c.defaultModel);
    });
    ui.resetContext();
    setInspected(undefined);
    setError('');
    setNotice('');
    pending.current = null;
  }, [braneId, refresh]);
  useEffect(() => {
    let active = true;
    setEstimate(undefined);
    if (!prompt.trim()) return;
    const timer = setTimeout(() => {
      void api('/runs/estimate', {
        braneId,
        key: crypto.randomUUID(),
        model,
        prompt,
        references: ui.references,
        continueFrom: ui.continueFrom,
        edits: Object.values(ui.draftRecords).map((d) => ({
          blockId: d.blockId,
          text: d.text,
          version: d.baseVersion,
        })),
      })
        .then((result) => {
          if (active) setEstimate(result);
        })
        .catch(() => {});
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [braneId, model, prompt, ui.references, ui.continueFrom, ui.draftRecords]);
  useEffect(() => {
    if (!ui.continueFrom) {
      setLineage([]);
      return;
    }
    void api<any[]>(`/context/lineage/${ui.continueFrom}`)
      .then(setLineage)
      .catch((e) => setError(e.message));
  }, [ui.continueFrom]);
  useEffect(() => {
    const reconcile = () => {
      void refresh().catch((e) => setError(e.message));
    };
    const onRun = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data.braneId !== braneId) return;
      if (data.status) {
        reconcile();
      } else if (data.text !== undefined)
        setState((s) =>
          s
            ? {
                ...s,
                runs: s.runs.map((r) => (r.id === data.runId ? { ...r, partial: data.text } : r)),
              }
            : s,
        );
    };
    window.addEventListener('brane:reconcile', reconcile);
    window.addEventListener('brane:run', onRun);
    const interval = setInterval(() => {
      if (stateRef.current?.blocks.some((b) => b.content.status === 'pending')) reconcile();
    }, 2000);
    return () => {
      window.removeEventListener('brane:reconcile', reconcile);
      window.removeEventListener('brane:run', onRun);
      clearInterval(interval);
    };
  }, [braneId, refresh]);
  const saveBlock = useCallback((id: string) => {
    clearTimeout(timers.current[id]);
    const work = saves.current
      .catch(() => {})
      .then(async () => {
        const interaction = useInteraction.getState();
        const text = interaction.drafts[id];
        if (text === undefined) return;
        const block = stateRef.current?.blocks.find((b) => b.id === id);
        if (!block) return;
        const draft = interaction.draftRecords[id];
        if (draft && draftDisposition(draft, block) === 'saved') {
          interaction.clearDraft(id, text);
          return;
        }
        if (draft && draftDisposition(draft, block) === 'conflict')
          throw new Error('Resolve the changed block below before saving or running.');
        await interaction.flushRecovery().catch(() => {});
        const result = await api(
          '/blocks/live',
          { blockId: id, text, version: draft?.baseVersion ?? block.version },
          'PATCH',
        ).catch(async (error) => {
          if (error instanceof ApiError && error.status === 409) {
            const next = await api<BraneState>(`/branes/${stateRef.current!.brane.id}`);
            stateRef.current = next;
            setState(next);
          }
          throw error;
        });
        setState((s) => {
          if (!s) return s;
          const next = {
            ...s,
            blocks: s.blocks.map((b) =>
              b.id === id ? { ...b, version: result.version, content: result.content } : b,
            ),
          };
          stateRef.current = next;
          return next;
        });
        if (stateRef.current)
          stateRef.current = {
            ...stateRef.current,
            blocks: stateRef.current.blocks.map((b) =>
              b.id === id ? { ...b, version: result.version, content: result.content } : b,
            ),
          };
        useInteraction.getState().clearDraft(id, text);
        if (useInteraction.getState().drafts[id] !== undefined)
          useInteraction.getState().rebase(id, result.version);
      });
    saves.current = work;
    return work;
  }, []);
  const edit = useCallback(
    (id: string, text: string) => {
      useInteraction
        .getState()
        .draft(id, text, stateRef.current?.blocks.find((b) => b.id === id)?.version ?? 0);
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => {
        void saveBlock(id).catch((e) => setError(e.message));
      }, 650);
    },
    [saveBlock],
  );
  const flush = useCallback(async () => {
    for (const block of stateRef.current?.blocks ?? []) await saveBlock(block.id);
    await saves.current;
  }, [saveBlock]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (Object.keys(useInteraction.getState().drafts).length || placementSaves.hasPending()) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('beforeunload', before);
    };
  }, []);
  const create = useCallback(
    async (g = { x: 100, y: 100, width: 320, height: 220 }) => {
      try {
        const b = await api('/blocks/text', { braneId, geometry: g });
        setNewBlock(b.id);
        await refresh();
        if (matchMedia('(max-width: 760px)').matches)
          void navigate({
            to: '/b/$braneId',
            params: { braneId },
            search: { focus: b.id, view: 'focus' },
          });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [braneId, refresh, navigate],
  );
  const saveGeometry = useCallback(
    (id: string, geometry: Geometry) => {
      const placement = stateRef.current?.placements.find((p) => p.id === id);
      if (!placement) return Promise.reject(new Error('Placement no longer exists.'));
      return placementSaves.save(placement, geometry);
    },
    [placementSaves],
  );
  const geometry = useCallback(
    (id: string, g: Geometry) => {
      // The queue exposes failure and explicit recovery controls in the route.
      void saveGeometry(id, g).catch(() => {});
    },
    [saveGeometry],
  );
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
  async function save() {
    try {
      await placementSaves.flush();
      await flush();
      await api(
        `/branes/${braneId}`,
        { title: titleDraft ?? stateRef.current!.brane.title },
        'PATCH',
      );
      await refresh();
      setTitleDraft(undefined);
      setNotice('Brane saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const spawn = useCallback(
    (blockId: string, placementId: string) => {
      if (spawningRef.current.has(blockId)) return;
      spawningRef.current.add(blockId);
      setSpawning([...spawningRef.current]);
      clearTimeout(timers.current[blockId]);
      setError('');
      // Join the autosave queue: earlier writes finish first, later writes wait until
      // the source edit and frozen input have committed together.
      const work = saves.current
        .catch(() => {})
        .then(async () => {
          let request = spawnRequests.current.get(blockId);
          if (!request) {
            const block = stateRef.current?.blocks.find((b) => b.id === blockId);
            if (!block) throw new Error('Source artifact is no longer available.');
            const draft = useInteraction.getState().draftRecords[blockId];
            if (draft && draftDisposition(draft, block) === 'conflict')
              throw new Error('Resolve the changed source before spawning.');
            request = {
              braneId,
              key: crypto.randomUUID(),
              sourceBlockIds: [blockId],
              anchorPlacementId: placementId,
              action: 'develop',
              model,
              edits:
                draft && draftDisposition(draft, block) !== 'saved'
                  ? [{ blockId, text: draft.text, version: draft.baseVersion }]
                  : [],
            };
            spawnRequests.current.set(blockId, request);
          }
          const result = await api<Run>('/artifacts/spawn', request);
          spawnRequests.current.delete(blockId);
          for (const edit of request.edits) {
            const current = stateRef.current;
            if (current) {
              const next = {
                ...current,
                blocks: current.blocks.map((b) =>
                  b.id === edit.blockId && b.version <= edit.version
                    ? {
                        ...b,
                        version: edit.version + 1,
                        content: { ...b.content, text: edit.text },
                      }
                    : b,
                ),
              };
              stateRef.current = next;
              setState(next);
            }
            const interaction = useInteraction.getState();
            interaction.clearDraft(edit.blockId, edit.text);
            interaction.rebase(
              edit.blockId,
              stateRef.current?.blocks.find((b) => b.id === edit.blockId)?.version ??
                edit.version + 1,
            );
          }
          setNotice('Artifact spawned · source context frozen');
          await refresh();
          setRevealedBlock(result.output_block_id);
          if (mobile) focusBlock(result.output_block_id);
        });
      saves.current = work;
      void work
        .catch((e) => {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500)
            spawnRequests.current.delete(blockId);
          setError(e.message);
        })
        .finally(() => {
          spawningRef.current.delete(blockId);
          setSpawning([...spawningRef.current]);
          setRetrySpawns([...spawnRequests.current.keys()]);
        });
    },
    [braneId, model, refresh, mobile, focusBlock],
  );
  async function run() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await flush();
      const input = pending.current ?? {
        braneId,
        key: crypto.randomUUID(),
        model,
        prompt,
        references: ui.references,
        continueFrom: ui.continueFrom,
        edits: [],
      };
      pending.current = input;
      await api('/runs', input);
      pending.current = null;
      setPrompt('');
      setNotice('Run submitted · context frozen');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const focusMode = view === 'focus' || (!view && mobile);
  const focused = state?.blocks.find((b) => b.id === focus) ?? state?.blocks[0];
  if (!state) return <div className="loading">{error || 'Opening brane…'}</div>;
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
                  <summary>Compare server text</summary>
                  <pre>{b.content.text}</pre>
                </details>
              )}
              <button
                onClick={() => {
                  ui.clearDraft(b.id, draft.text);
                  setError('');
                }}
              >
                Use server text
              </button>
              <button
                onClick={async () => {
                  try {
                    if (conflict) ui.rebase(b.id, b.version);
                    await saveBlock(b.id);
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
        <div className="workspace">
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
            <button onClick={() => fileInput.current?.click()}>▧ Image</button>
            <button onClick={() => setWebOpen(!webOpen)}>↗ Webpage</button>
            {selectedBlocks.length > 0 && (
              <button onClick={() => ui.addReferences(selectedBlocks)}>
                Use {selectedBlocks.length} as context
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const data = new FormData();
                data.append('file', file);
                data.append('braneId', braneId);
                try {
                  await api('/assets', data);
                  await refresh();
                } catch (err) {
                  setError((err as Error).message);
                }
                e.target.value = '';
              }}
            />
          </div>
          {webOpen && (
            <form
              className="web-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api('/ingest', { braneId, url });
                  setWebOpen(false);
                  setUrl('');
                  await refresh();
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
          {error && (
            <div role="alert" className="error-banner">
              {error}
              <button
                onClick={() => {
                  setError('');
                  void refresh();
                }}
              >
                Reload state
              </button>
              {pending.current && (
                <button
                  onClick={() => {
                    pending.current = null;
                    setNotice('Next Run will submit a new request');
                    setError('');
                  }}
                >
                  Discard pending submission
                </button>
              )}
            </div>
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
            <div className="prompt-row">
              <textarea
                aria-label="Run prompt"
                placeholder="Where should this thought go next?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (prompt.trim()) void run();
                  }
                }}
              />
              <button
                className="primary run-button"
                disabled={busy || (!pending.current && !prompt.trim())}
                onClick={() => void run()}
              >
                {busy ? 'Submitting…' : pending.current ? 'Retry submission ↗' : 'Run ↗'}
              </button>
            </div>
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
              <span>{vision[model]?.vision ? 'Image context supported' : 'Text-only model'}</span>
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
                            void api(`/revisions/${m.revision_id}`).then((r) =>
                              setNotice(r.content.text.slice(0, 180)),
                            );
                        }}
                      >
                        {m.role}: {JSON.parse(m.content_json).text.slice(0, 55)}
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
              ◎ At Run, this context becomes an immutable snapshot. Keep editing freely.
            </div>
            <div className="section-label">
              EXPLORATIONS <span>{state.runs.length}</span>
            </div>
            <div className="run-list">
              {[...state.runs].reverse().map((r, i) => (
                <div className="run-item" key={r.id}>
                  <button
                    className="run-inspect"
                    onClick={() =>
                      void api(`/runs/${r.id}`)
                        .then(setInspected)
                        .catch((e) => setError(e.message))
                    }
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
                        await api(`/runs/${r.id}/cancel`, {});
                        await refresh();
                      }}
                    >
                      Cancel run
                    </button>
                  )}
                  {['failed', 'interrupted', 'cancelled'].includes(r.status) && (
                    <button
                      onClick={async () => {
                        try {
                          await api(`/runs/${r.id}/retry`, { key: crypto.randomUUID() });
                          await refresh();
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
            {inspected && (
              <div className="frozen-inspector">
                <div className="section-label">
                  EXACT SUBMITTED INPUTS <button onClick={() => setInspected(undefined)}>×</button>
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
                    {input.content.assetId && (
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
