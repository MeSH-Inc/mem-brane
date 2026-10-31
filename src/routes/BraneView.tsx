import { matrixOf } from '../canvas/matrix';
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
import { openSpot } from '../canvas/machines';
import { SELECTION_MACHINE_TEMPLATE } from '../../shared/machines';
import { CardBack, CardArrows } from '../canvas/CardBack';
import { MachineControls } from '../canvas/MachineControls';
import { ASK_HEIGHT, ASK_WIDTH, type AskPosition } from '../canvas/AskBox';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  lazy,
  Suspense,
  useMemo,
} from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import type { Geometry, Placement } from '../../shared/types/domain';
import { api, replica, needsAccount } from '../services/api';
import { RunIssueNotice } from '../components/RunIssueNotice';
import { useInteraction } from '../stores/interaction';
import { presentationFor } from '../stores/presentation';
import { useStore } from 'zustand';
import { LiveBlockContent } from '../components/LiveBlockContent';
import { SpawnButton } from '../components/SpawnButton';
import { ArtifactActions, type CardAction } from '../components/ArtifactActions';
import { FirstSteps } from '../components/FirstSteps';
import { RunHistory } from '../components/RunHistory';
import { RunInputs } from '../components/RunInputs';
import { UnplacedCards } from '../components/UnplacedCards';
import { Workshop } from '../components/Workshop';
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

type BraneViewProps = {
  braneId: string;
  focus?: string;
  view?: 'canvas' | 'focus';
  inputs?: string;
};

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

function BraneWorkspace({ braneId, focus, view, inputs }: BraneViewProps) {
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
    runFailure,
    estimateIssue,
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
    [unplacedOpen, setUnplacedOpen] = useState(false),
    [workshopOpen, setWorkshopOpen] = useState(false),
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
  const submitRun = async () => {
    if (needsAccount()) return;
    const attention = presentation.getState().attention;
    const reconciling = submission.state.status === 'uncertain';
    const box = askAt;
    const id = await run(
      canvasAsk && box ? { x: box.x, y: box.y, width: ASK_WIDTH, height: ASK_HEIGHT } : undefined,
    );
    if (id && box) setAskAt((current) => (current?.id === box.id ? undefined : current));
    // The sheet closes with its question; a question written meanwhile keeps it open.
    if (id && !canvasAsk && !controller.draft.prompt?.trim()) setAskSheet(false);
    if (!id || reconciling) return;
    const placementId = controller.state?.placements.find((p) => p.block_id === id)?.id;
    if (
      presentation.getState().reveal(attention, { blockId: id, placementId, kind: 'reveal' }) &&
      (focusMode || mobile)
    )
      focusBlock(id);
  };
  // Exact inputs live in the URL, so Back and shared links reopen the same run.
  const router = useRouter();
  const pushedInputs = useRef<string>(undefined);
  const [inputsError, setInputsError] = useState('');
  useEffect(() => {
    let current = true;
    if (!inputs) pushedInputs.current = undefined;
    setInputsError('');
    void controller.inspect(inputs).catch((e) => current && setInputsError(e.message));
    return () => {
      current = false;
    };
  }, [controller, inputs]);
  const inspectRun = useCallback(
    (runId: string) => {
      pushedInputs.current = runId;
      void navigate({
        to: '/b/$braneId',
        params: { braneId },
        search: (previous) => ({ ...previous, inputs: runId }),
      });
    },
    [braneId, navigate],
  );
  const closeInputs = useCallback(() => {
    if (inputs && pushedInputs.current === inputs) router.history.back();
    else
      void navigate({
        to: '/b/$braneId',
        params: { braneId },
        search: (previous) => ({ ...previous, inputs: undefined }),
        replace: true,
      });
  }, [braneId, inputs, navigate, router]);
  const rerun = useCallback(
    (runId: string) => {
      const derivation = controller.state?.derivations.find((d) => d.runId === runId);
      if (!derivation) return;
      const run = controller.state?.runs.find((r) => r.id === runId);
      if (run?.machine_block_id) {
        const machine =
          controller.state?.placements.find((p) => p.id === derivation.anchorPlacementId) ??
          controller.state?.placements.find((p) => p.block_id === run.machine_block_id);
        if (machine && !needsAccount()) void controller.runMachine(machine.id);
        else if (!machine) controller.setError('Place the machine on this brane to update it.');
        return;
      }
      if (derivation.kind === 'source') {
        const placement = controller.state?.placements.find(
          (p) => p.block_id === derivation.sourceBlockId,
        );
        if (placement) spawn(derivation.sourceBlockId, placement.id);
      } else
        void controller
          .reuseInputs(runId)
          .then(() => reuseOpened.current?.(run?.output_block_id))
          .catch((e) => controller.setError(e.message));
    },
    [controller, spawn],
  );
  // Reuse loads a run's prompt and current sources; the box opens beside its answer.
  const reuseOpened = useRef<(outputBlockId?: string) => void>(undefined);
  const manage = useCallback(
    (blockId: string, placementId: string, view: CardAction) =>
      setManaged({ blockId, placementId, view }),
    [],
  );
  const continueBranch = (messageId?: string) => {
    controller.setContinue(messageId);
    if (!messageId) return;
    const block = controller.state?.blocks.find((b) => b.messageId === messageId);
    if (asking) focusPrompt();
    else openAskAt(block ? placementsOf([block.id]) : []);
  };
  const attentionRef = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertionReady = useCallback((getPoint: () => { x: number; y: number }) => {
    canvasInsertion.current = getPoint;
  }, []);
  const pickerTarget = useRef<'canvas' | 'composer'>('canvas');
  const canvasInsertion = useRef<() => { x: number; y: number }>(() => ({ x: 100, y: 100 }));
  const machineActions = useMemo(
    () => ({
      // The output is revealed in the tray, moving the view only if it is out of sight.
      onRunMachine: async (placementId: string) => {
        if (needsAccount()) return;
        const attention = presentation.getState().attention;
        const id = await controller.runMachine(placementId);
        if (id) presentation.getState().reveal(attention, { blockId: id, kind: 'reveal' });
      },
      onEstimateMachine: controller.estimateMachine,
      onFeed: controller.feed,
      onUnfeed: controller.unfeed,
      onFeedMode: controller.setFeedMode,
      onSaveToWorkshop: (blockId: string) =>
        void controller.saveToWorkshop(blockId).then((saved) => saved && setWorkshopOpen(true)),
      // The copy is brought into view and selected, ready for its prompt to be edited.
      onDuplicate: (placementId: string) =>
        void controller.duplicateMachine(placementId).then((id) => {
          const copy = controller.state?.placements.find((p) => p.block_id === id);
          if (!id || !copy) return;
          useInteraction.getState().setSelectedPlacements([copy.id]);
          presentation
            .getState()
            .reveal(presentation.getState().attention, { blockId: id, kind: 'reveal' });
        }),
      models,
    }),
    [controller, needsAccount, presentation, models],
  );
  const tablePlacements = () =>
    (controller.state?.placements ?? []).filter((p) => !p.host_placement_id);
  const createMachine = useCallback(
    async (template?: string) => {
      const attention = presentation.getState().attention;
      const id = await controller.createMachine(
        openSpot(tablePlacements(), canvasInsertion.current(), 400, 340),
        template,
      );
      const placementId = controller.state?.placements.find((p) => p.block_id === id)?.id;
      if (!id || !placementId) return;
      useInteraction.getState().setSelectedPlacements([placementId]);
      // The open space beside the view's centre may lie outside the view; bring it in.
      presentation.getState().reveal(attention, { blockId: id, placementId, kind: 'reveal' });
    },
    [controller, presentation],
  );
  // Focus lists and opens cards on the table; what is on a back is read on its host.
  const tableBlocks = (state?.blocks ?? []).filter((b) =>
    state?.placements.some((p) => p.block_id === b.id && !p.host_placement_id),
  );
  // The cards the selection chips act on, in reading order; machines are excluded.
  const selectedCards = (() => {
    if (!state || focusMode || mobile) return [];
    const kinds = new Map(state.blocks.map((b) => [b.id, b]));
    return state.placements
      .filter(
        (p) =>
          !p.host_placement_id &&
          ui.selectedPlacements.includes(p.id) &&
          kinds.get(p.block_id)?.kind !== 'machine',
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);
  })();
  const developable =
    selectedCards.length === 1 &&
    state?.blocks.find((b) => b.id === selectedCards[0].block_id)?.origin === 'authored'
      ? selectedCards[0]
      : undefined;
  // Selection never changes the composer's context by itself; it offers to add it.
  const unreferencedSelection = selectedBlockIds(selectedCards, ui.selectedPlacements).filter(
    (id) => !ui.references.includes(id),
  );
  const replyTo =
    selectedCards.length === 1
      ? state?.blocks.find((b) => b.id === selectedCards[0].block_id)?.messageId
      : undefined;
  // On the desktop canvas the prompt lives in an Ask box on the table, beside what it
  // asks about, and its answer takes the box's place. Focus and phones, which have no
  // table to place it on, open it as a sheet over the bottom of the view.
  const canvasAsk = !focusMode && !mobile;
  const [askAt, setAskAt] = useState<AskPosition>();
  // An unsent question or an unconfirmed Run is never left behind a closed sheet: the
  // sheet opens with the brane when either is there.
  const [askSheet, setAskSheet] = useState(
    () =>
      !!prompt.trim() ||
      references.length > 0 ||
      !!continueFrom ||
      submission.state.status === 'uncertain',
  );
  // A box open on the table becomes the sheet when the view loses its table.
  useEffect(() => {
    if (canvasAsk || !askAt) return;
    setAskAt(undefined);
    setAskSheet(true);
  }, [canvasAsk, askAt]);
  const focusPrompt = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('[aria-label="Run prompt"]')?.focus(),
    );
  // Beside the placements, or below them when that is nearer to open space; at the view's
  // centre when there are none.
  const openAskAt = (around: Placement[]) => {
    if (!canvasAsk) {
      setAskSheet(true);
      return focusPrompt();
    }
    const table = tablePlacements();
    let spot = openSpot(table, canvasInsertion.current(), ASK_WIDTH, ASK_HEIGHT);
    if (around.length) {
      const right = Math.max(...around.map((p) => p.x + p.width));
      const left = Math.min(...around.map((p) => p.x));
      const bottom = Math.max(...around.map((p) => p.y + p.height));
      const top = Math.min(...around.map((p) => p.y));
      const beside = openSpot(table, { x: right + 80, y: top }, ASK_WIDTH, ASK_HEIGHT);
      const below = openSpot(table, { x: left, y: bottom + 40 }, ASK_WIDTH, ASK_HEIGHT);
      spot =
        Math.hypot(beside.x - right, beside.y - top) <= Math.hypot(below.x - left, below.y - bottom)
          ? beside
          : below;
    }
    setAskAt({ id: crypto.randomUUID(), x: spot.x, y: spot.y });
  };
  const placementsOf = (blockIds: string[]) =>
    tablePlacements().filter((p) => blockIds.includes(p.block_id));
  // Ask about the selection: exactly these cards, as a new question.
  const openAsk = () => {
    ui.setReferences(selectedBlockIds(selectedCards, ui.selectedPlacements));
    ui.setContinue(undefined);
    openAskAt(selectedCards);
  };
  const closeAsk = useCallback(() => {
    setAskAt(undefined);
    setAskSheet(false);
  }, []);
  const asking = canvasAsk ? !!askAt : askSheet;
  // Cards receive stable callbacks so typing a prompt never re-renders the table.
  const latestAsk = useRef({ addContext: (_: string[]) => {}, continueBranch: (_?: string) => {} });
  const canvasContext = useCallback((ids: string[]) => latestAsk.current.addContext(ids), []);
  const canvasContinue = useCallback(
    (messageId?: string) => latestAsk.current.continueBranch(messageId),
    [],
  );
  // Adding a card from its menu opens the box beside it if none is open.
  const addContext = (ids: string[]) => {
    controller.addReferences(ids);
    if (!asking) openAskAt(placementsOf(ids));
    else focusPrompt();
  };
  // Make reusable: a machine whose prompt is the question and whose one slot is fed
  // with the cards the answer was asked about. Braces in the question would name
  // slots of their own, so they become parentheses.
  const makeReusable = useCallback(
    async (runId: string, question: string) => {
      const current = controller.state;
      if (!current) return;
      const tableOf = (blockId: string) =>
        current.placements.find((p) => p.block_id === blockId && !p.host_placement_id);
      const answer = tableOf(current.runs.find((r) => r.id === runId)?.output_block_id ?? '');
      const sources = current.derivations
        .filter((d) => d.runId === runId && d.kind === 'reference')
        .flatMap((d) => tableOf(d.sourceBlockId) ?? []);
      if (!answer) return;
      const template = `${question.replace(/\{/g, '(').replace(/\}/g, ')')}\n\n{cards}`;
      const id = await controller.createMachine(
        openSpot(
          current.placements.filter((p) => !p.host_placement_id),
          { x: answer.x + answer.width + 80, y: answer.y },
          400,
          340,
        ),
        template,
      );
      const machine = controller.state?.placements.find((p) => p.block_id === id);
      if (!machine) return;
      if (sources.length)
        await controller.feed(
          sources.map((p) => p.id),
          machine.id,
          'cards',
        );
      useInteraction.getState().setSelectedPlacements([machine.id]);
    },
    [controller],
  );
  const focusBack = useMemo(
    () => ({
      onDetach: controller.detach,
      onReuse: makeReusable,
      onUpdate: controller.update,
      onOpenSource: focusBlock,
      onInspect: inspectRun,
      onRerun: rerun,
      onStop: controller.cancelRun,
      onRetry: controller.retryRun,
    }),
    [controller, makeReusable, focusBlock, inspectRun, rerun],
  );
  // Critique is a machine pre-fed from the selection: the first card in reading order
  // is the claim and the rest are its evidence. It runs only when its lever is pulled.
  // Place a machine beside the selection and feed its cards into the named slots. It
  // runs only when its lever is pulled.
  const feedNewMachine = async (
    template: string | undefined,
    slots: [slot: string, cards: Placement[]][],
    edit = false,
  ) => {
    const cards = selectedCards;
    if (!cards.length) return;
    const attention = presentation.getState().attention;
    const right = Math.max(...cards.map((p) => p.x + p.width));
    const id = await controller.createMachine(
      openSpot(tablePlacements(), { x: right + 80, y: cards[0].y }, 400, 340),
      template,
    );
    const machine = controller.state?.placements.find((p) => p.block_id === id);
    if (!id || !machine) return;
    for (const [slot, fed] of slots)
      if (fed.length)
        await controller.feed(
          fed.map((p) => p.id),
          machine.id,
          slot,
        );
    useInteraction.getState().setSelectedPlacements([machine.id]);
    if (edit)
      presentation
        .getState()
        .reveal(attention, { blockId: id, placementId: machine.id, kind: 'edit' });
  };
  // Critique: the first card in reading order is the claim, the rest its evidence.
  const critique = () =>
    feedNewMachine(undefined, [
      ['claim', selectedCards.slice(0, 1)],
      ['evidence', selectedCards.slice(1)],
    ]);
  // Machine: one {cards} slot fed with the whole selection, its prompt ready to edit.
  const machineFromSelection = () =>
    feedNewMachine(SELECTION_MACHINE_TEMPLATE, [['cards', selectedCards]], true);
  // The group whose cards on the table are exactly the selection, if there is one.
  const chosenGroup = state?.groups.find((g) => {
    const members = g.members.filter((id) => selectedCards.some((p) => p.id === id));
    return members.length === selectedCards.length && members.length === g.members.length;
  });
  const groupable = selectedCards.length > 1 && !chosenGroup;
  // Matrix is offered for a group of machines' outputs run each over one stack.
  const matrixAvailable =
    !!state && !!chosenGroup && chosenGroup.display !== 'matrix' && !!matrixOf(state, chosenGroup);
  const groupSelection = () => void controller.group(selectedCards.map((p) => p.id));
  const flipSelection = () => {
    const interaction = useInteraction.getState();
    const back = !selectedCards.every((p) => interaction.flipped.includes(p.id));
    for (const p of selectedCards) interaction.flip(p.id, back);
  };
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
  const showCardHere = useCallback(
    async (blockId: string) => {
      await commands.run(`restore:${blockId}`, async (progress) => {
        // Read the durable local projection again on retries, including when an
        // earlier placement succeeded but refreshing the visible workspace failed.
        const latest = await client.workspace(braneId);
        if (!latest.placements.some((placement) => placement.block_id === blockId))
          await client.createPlacement(braneId, blockId, {
            ...canvasInsertion.current(),
            width: 320,
            height: 240,
          });
        progress('refreshing');
        await refresh();
      });
    },
    [braneId, commands, refresh],
  );
  const focused = state?.blocks.find((b) => b.id === (focus ?? retainedFocus)) ?? tableBlocks[0];
  const focusedPlacement =
    focused && state?.placements.find((p) => p.block_id === focused.id && !p.host_placement_id);
  if (!state) return <div className="loading">{error || 'Opening brane…'}</div>;
  const availableDrafts = ui.availableDrafts.filter((d) =>
    state.blocks.some((b) => b.id === d.blockId),
  );
  const draftAttention = state.blocks.filter(
    (b) =>
      ui.draftRecords[b.id] &&
      (ui.recovered.includes(b.id) || draftDisposition(ui.draftRecords[b.id], b) === 'conflict'),
  ).length;
  const operationError =
    error ||
    workspace.error ||
    pendingRuns.error ||
    spawnRequests.error ||
    submission.state.status === 'uncertain';
  const attentionCount =
    (ui.recoveryError ? 1 : 0) +
    (availableDrafts.length ? 1 : 0) +
    draftAttention +
    placementFailures.length +
    (operationError ? 1 : 0) +
    (retrySpawns.length ? 1 : 0) +
    (imports.recoveryError ? 1 : 0) +
    (controller.titleError ? 1 : 0);
  // The prompt: what it is asked about, the question, and why it cannot run yet.
  const promptPanel = (
    <>
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
            {i + 1} · {state.blocks.find((b) => b.id === id)?.content.text.slice(0, 23) || 'Card'} ×
          </button>
        ))}
        {unreferencedSelection.length > 0 && (
          <button className="suggest-chip" onClick={() => ui.addReferences(unreferencedSelection)}>
            + Add {unreferencedSelection.length} selected
          </button>
        )}
        {!ui.references.length && !ui.continueFrom && <span className="muted">Prompt only</span>}
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
              if ((prompt.trim() || submission.state.status === 'uncertain') && !needsAccount())
                void submitRun();
            }
          }}
        />
        <button
          className="primary run-button"
          aria-describedby={runFailure ? 'run-issue' : estimateIssue ? 'estimate-issue' : undefined}
          disabled={
            busy ||
            (submission.state.status !== 'uncertain' &&
              (pendingAttachments ||
                !!compatibilityError ||
                !!estimateIssue?.blocking ||
                !prompt.trim()))
          }
          onClick={() => {
            if (!needsAccount()) void submitRun();
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
      {pendingAttachments && <small>Finish or dismiss failed attachments before running.</small>}
      {compatibilityError && (
        <p role="alert" className="error">
          {compatibilityError}
        </p>
      )}
      {!runFailure && estimateIssue && submission.state.status !== 'uncertain' && (
        <RunIssueNotice
          id="estimate-issue"
          issue={estimateIssue}
          model={model}
          models={models}
          canRunAgain={false}
          onUseMock={() => setModel('mock')}
          onRunAgain={() => {}}
        />
      )}
      {runFailure && !busy && (
        <RunIssueNotice
          id="run-issue"
          issue={runFailure}
          model={model}
          models={models}
          canRunAgain={submission.state.status !== 'uncertain' && !!prompt.trim()}
          onUseMock={() => setModel('mock')}
          onRunAgain={() => void submitRun()}
        />
      )}
      {estimate && model !== 'mock' && (
        <p className="ask-estimate">
          {estimate.canAfford ? 'Up to' : 'Needs'} {formatUsd(estimate.reservedMicrousd)}
        </p>
      )}
    </>
  );
  latestAsk.current = { addContext, continueBranch };
  reuseOpened.current = (outputBlockId) =>
    openAskAt(placementsOf(outputBlockId ? [outputBlockId] : []));
  return (
    <div
      className="brane-workspace"
      onPointerDownCapture={presentation.getState().interact}
      onKeyDownCapture={presentation.getState().interact}
      onKeyDown={(event) => {
        // F turns the selection over and D develops one card, unless typing.
        const target = event.target as HTMLElement;
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          target.closest('input, textarea, select, [contenteditable="true"]')
        )
          return;
        if (event.key === 'f' && selectedCards.length) {
          event.preventDefault();
          flipSelection();
        } else if (event.key === '/') {
          event.preventDefault();
          if (selectedCards.length) openAsk();
          else openAskAt([]);
        } else if (event.key === 'd' && developable) {
          event.preventDefault();
          spawn(developable.block_id, developable.id);
        } else if (event.key === 'g' && groupable) {
          event.preventDefault();
          groupSelection();
        }
      }}
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
          <button
            className="ask-button"
            title="Ask about the selection, or ask anything (/)"
            onClick={() => (selectedCards.length ? openAsk() : openAskAt([]))}
          >
            Ask
          </button>
          <ActionMenu label="＋ Add">
            <CommandButton
              tasks={commands}
              taskKey="create"
              pendingLabel="Creating…"
              onClick={() => void create()}
            >
              ＋ Text
            </CommandButton>
            {!focusMode && <button onClick={() => void createMachine()}>⚙ Machine</button>}
            <button
              onClick={() => {
                pickerTarget.current = 'canvas';
                fileInput.current?.click();
              }}
            >
              ▧ Image / PDF
            </button>
            <button onClick={() => setWebOpen(!webOpen)}>↗ Webpage</button>
            <button onClick={() => setUnplacedOpen(true)}>Unplaced cards</button>
            {!focusMode && <button onClick={() => setWorkshopOpen(true)}>⚒ Workshop</button>}
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
      {/* Everything that needs a decision lives in this one region. */}
      <section
        ref={attentionRef}
        tabIndex={-1}
        className={`attention${attentionCount ? ' active' : ''}`}
        aria-label="Needs attention"
      >
        {attentionCount > 0 && (
          <strong className="attention-heading">
            {attentionCount === 1 ? '1 thing needs' : `${attentionCount} things need`} your
            attention
          </strong>
        )}
        {ui.recoveryError && (
          <div role="alert" className="attention-item">
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
              <div className="draft-recovery attention-item" key={b.id}>
                <strong>
                  {conflict
                    ? 'This card changed in another tab or device'
                    : 'Recovered unsaved text'}
                </strong>
                <p>{draft.text.slice(0, 140)}</p>
                {conflict && (
                  <details>
                    <summary>Compare original, my text and the other version</summary>
                    <h4>Original text (version {draft.baseVersion})</h4>
                    <pre>{draft.baseText}</pre>
                    <h4>My text</h4>
                    <pre>{draft.text}</pre>
                    <h4>Other version (version {b.version})</h4>
                    <pre>{b.content.text}</pre>
                  </details>
                )}
                <button
                  onClick={() => {
                    controller.useServerText(b.id);
                    setError('');
                  }}
                >
                  Keep the other version
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
                  {conflict ? 'Keep my text' : 'Save my text'}
                </CommandButton>
              </div>
            );
          })}
        {placementFailures.map((failure) => (
          <div className="attention-item" role="alert" key={failure.id}>
            <span>A card move wasn’t saved. {failure.message} You’re seeing your latest move.</span>
            <button disabled={failure.busy} onClick={() => void placementSaves.retry(failure.id)}>
              Save my move
            </button>
            <button disabled={failure.busy} onClick={() => void placementSaves.discard(failure.id)}>
              Put it back
            </button>
          </div>
        ))}
        {(error ||
          workspace.error ||
          pendingRuns.error ||
          spawnRequests.error ||
          submission.state.status === 'uncertain') && (
          <div role="alert" className="attention-item">
            {error || workspace.error || pendingRuns.error || spawnRequests.error}
            <button
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              Reload
            </button>
            {submission.state.status === 'uncertain' && (
              <p>
                We couldn’t confirm your last Run reached the server. Retrying checks it without
                running twice; later prompt edits are kept for your next Run.
              </p>
            )}
          </div>
        )}
        {retrySpawns.length > 0 && (
          <p className="attention-item">
            We couldn’t confirm a Develop reached the server. Retry Develop checks it without
            running twice, using the text it was sent with.
          </p>
        )}
        {imports.recoveryError && (
          <p role="alert" className="attention-item">
            {imports.recoveryError}
          </p>
        )}
      </section>
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
          {importTasks.length > 0 && <ImportTray tasks={importTasks} />}
          <RunActivity controller={controller} onOpen={focusBlock} />
          {focusMode ? (
            <div className="focus-layout">
              <nav className="block-outline">
                <span className="eyebrow">CARDS / {tableBlocks.length}</span>
                {tableBlocks.map((b, i) => (
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
                    onStop={controller.cancelRun}
                    onRetry={controller.retryRun}
                  />
                  {focusedPlacement &&
                    (focused.kind === 'machine' ? (
                      <div className="focus-machine">
                        <MachineControls
                          placementId={focusedPlacement.id}
                          blockId={focused.id}
                          document={controller.document}
                          actions={machineActions}
                        />
                      </div>
                    ) : (
                      <section className="focus-back" aria-label="Back">
                        <span className="eyebrow">Back</span>
                        <CardBack
                          placementId={focusedPlacement.id}
                          blockId={focused.id}
                          document={controller.document}
                          actions={focusBack}
                        />
                        <CardArrows
                          placementId={focusedPlacement.id}
                          document={controller.document}
                          onRemove={controller.unrelate}
                        />
                      </section>
                    ))}
                  <footer>
                    {focused.origin !== 'generated' && focused.kind !== 'machine' && (
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
                    )}
                    {focused.messageId ? (
                      <button onClick={() => continueBranch(focused.messageId)}>⑂ Continue</button>
                    ) : (
                      focused.kind !== 'machine' && (
                        <button onClick={() => addContext([focused.id])}>+ Use as context</button>
                      )
                    )}
                    <ActionMenu label="More" align="right">
                      {focused.messageId && (
                        <button onClick={() => addContext([focused.id])}>+ Use as context</button>
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
                  <FirstSteps />
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
                  <FirstSteps />
                </div>
              )}
              <BraneCanvas
                mobile={mobile}
                onContext={canvasContext}
                onContinue={canvasContinue}
                onImport={attachFiles}
                onInsertionReady={insertionReady}
                document={controller.document}
                onStop={controller.cancelRun}
                onRetry={controller.retryRun}
                onSpawn={spawn}
                onCreate={create}
                onEdit={edit}
                onGeometry={geometry}
                onFocus={focusBlock}
                onManage={manage}
                onInspect={inspectRun}
                onRerun={rerun}
                onDetach={controller.detach}
                onReuse={makeReusable}
                onUpdate={controller.update}
                onRelate={controller.relate}
                onRelabel={controller.relabel}
                onUnrelate={controller.unrelate}
                onFeedGroup={controller.feedGroup}
                onRenameGroup={controller.renameGroup}
                onTakeOut={controller.takeOutOfGroup}
                onKeep={controller.keepOutput}
                ask={canvasAsk && askAt ? { ...askAt, content: promptPanel } : undefined}
                onCloseAsk={closeAsk}
                machine={machineActions}
              />
            </Suspense>
          )}
          <div className="composer">
            {selectedCards.length > 0 && (
              <div className="selection-chips" role="toolbar" aria-label="Selection">
                <span className="muted">
                  {selectedCards.length === 1 ? '1 card' : `${selectedCards.length} cards`}
                </span>
                {developable && (
                  <button
                    title="Develop this card onto its back (D)"
                    onClick={() => spawn(developable.block_id, developable.id)}
                  >
                    Develop
                  </button>
                )}
                <button title="Ask a question of these cards (/)" onClick={openAsk}>
                  Ask about {selectedBlockIds(selectedCards, ui.selectedPlacements).length}
                </button>
                {replyTo && (
                  <button
                    title="Continue this response's conversation in the prompt below"
                    onClick={() => continueBranch(replyTo)}
                  >
                    Reply
                  </button>
                )}
                <button
                  title="A Critique machine fed with the first card as the claim and the rest as evidence"
                  onClick={() => void critique()}
                >
                  Critique
                </button>
                <button
                  title="A machine fed with these cards; write its prompt, then pull its lever"
                  onClick={() => void machineFromSelection()}
                >
                  Machine
                </button>
                {groupable && (
                  <button
                    title="Make these cards one group that moves and feeds as one (G)"
                    onClick={groupSelection}
                  >
                    Group
                  </button>
                )}
                {chosenGroup && (
                  <>
                    <button
                      title={
                        chosenGroup.display === 'stack'
                          ? 'Lay the stack out as a region'
                          : 'Pile these cards into one card’s space'
                      }
                      onClick={() =>
                        void controller.arrangeGroup(
                          chosenGroup.id,
                          chosenGroup.display === 'stack' ? 'region' : 'stack',
                        )
                      }
                    >
                      {chosenGroup.display === 'stack' ? 'Spread' : 'Stack'}
                    </button>
                    {matrixAvailable && (
                      <button
                        title="A row per card the machines ran over, a column per machine"
                        onClick={() => void controller.arrangeGroup(chosenGroup.id, 'matrix')}
                      >
                        Matrix
                      </button>
                    )}
                    <button
                      title="Keep the cards where they are, without the group"
                      onClick={() => void controller.ungroup(chosenGroup.id)}
                    >
                      Ungroup
                    </button>
                  </>
                )}
                <button title="Turn over (F)" onClick={flipSelection}>
                  Flip
                </button>
              </div>
            )}
            {!canvasAsk && askSheet && (
              <section
                className="ask-sheet"
                aria-label="Ask"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    closeAsk();
                  }
                }}
              >
                <header>
                  <span className="eyebrow">Ask</span>
                  <button className="text-button" aria-label="Close Ask" onClick={closeAsk}>
                    ×
                  </button>
                </header>
                {promptPanel}
              </section>
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
              <span className="save-notice" role="status">
                {attentionCount
                  ? `Needs attention (${attentionCount})`
                  : titleDraft !== undefined ||
                      Object.keys(ui.drafts).length ||
                      placementSaves.hasPending() ||
                      commands.pending('title')
                    ? 'Saving…'
                    : sync.pending
                      ? 'Saved on device · Syncing…'
                      : 'Saved'}
              </span>
              {attentionCount > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    attentionRef.current?.scrollIntoView({ block: 'nearest' });
                    attentionRef.current?.focus();
                  }}
                >
                  Review
                </button>
              )}
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
                            onClick={() => inspectRun(r.id)}
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
                    onInspect={inspectRun}
                  />
                </>
              )}
            </aside>
          </Dialog>
        )}
        {inputs && (
          <RunInputs
            key={inputs}
            runId={inputs}
            run={inspected}
            error={inputsError}
            outputPresent={
              !!inspected && state.blocks.some((b) => b.id === inspected.output_block_id)
            }
            commands={commands}
            onShowHere={showCardHere}
            onOpenOutput={focusBlock}
            onClose={closeInputs}
          />
        )}
        {workshopOpen && (
          <Workshop
            onTakeOut={(template) => {
              setWorkshopOpen(false);
              void createMachine(template);
            }}
            onClose={() => setWorkshopOpen(false)}
          />
        )}
        {unplacedOpen && (
          <UnplacedCards
            commands={commands}
            onShowHere={showCardHere}
            onOpen={(id) => {
              setUnplacedOpen(false);
              focusBlock(id);
            }}
            onClose={() => setUnplacedOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
