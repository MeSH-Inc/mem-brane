import { create } from 'zustand';
import type { CanvasTool } from '../canvas/tools';
import { DraftRecovery, indexedDraftStorage, draftKey, type Draft } from '../services/drafts';
const recovery = new DraftRecovery(indexedDraftStorage());
interface Interaction {
  actor?: string;
  recovered: string[];
  draftRecords: Record<string, Draft>;
  recoveryError?: string;
  initialize: (actor: string) => Promise<void>;
  flushRecovery: () => Promise<void>;
  rebase: (id: string, version: number) => void;
  selectedPlacements: string[];
  drafts: Record<string, string>;
  references: string[];
  continueFrom?: string;
  tool: CanvasTool;
  inspector: boolean;
  setSelectedPlacements: (ids: string[]) => void;
  draft: (id: string, text: string, version: number) => void;
  clearDraft: (id: string, text: string) => void;
  addReferences: (ids: string[]) => void;
  setReferences: (ids: string[]) => void;
  setContinue: (id?: string) => void;
  setTool: (tool: CanvasTool) => void;
  setInspector: (open: boolean) => void;
  resetContext: () => void;
}
export const useInteraction = create<Interaction>((set, get) => ({
  recovered: [],
  draftRecords: {},
  initialize: async (actor) => {
    set({ actor, drafts: {}, draftRecords: {}, recovered: [], recoveryError: undefined });
    try {
      const records = await recovery.load(actor);
      if (get().actor !== actor) return;
      set({
        recovered: records.map((d) => d.blockId),
        draftRecords: Object.fromEntries(records.map((d) => [d.blockId, d])),
        drafts: Object.fromEntries(records.map((d) => [d.blockId, d.text])),
      });
    } catch {
      set({
        recoveryError: 'Draft recovery is unavailable. Keep this tab open until edits are saved.',
      });
    }
  },
  flushRecovery: () => recovery.flush(),
  rebase: (id, version) => {
    const record = get().draftRecords[id];
    if (record) {
      const next = { ...record, baseVersion: version };
      set((s) => ({ draftRecords: { ...s.draftRecords, [id]: next } }));
      void recovery
        .save(next)
        .catch(() => set({ recoveryError: 'Could not preserve your draft locally.' }));
    }
  },
  selectedPlacements: [],
  drafts: {},
  references: [],
  tool: 'write',
  inspector: true,
  setSelectedPlacements: (ids) =>
    set((state) => {
      const selectedPlacements = [...new Set(ids)].sort();
      return selectedPlacements.length === state.selectedPlacements.length &&
        selectedPlacements.every((id, index) => id === state.selectedPlacements[index])
        ? state
        : { selectedPlacements };
    }),
  draft: (id, text, version) => {
    const state = get();
    if (!state.actor) return;
    const record: Draft = {
      key: draftKey(state.actor, id),
      actor: state.actor,
      blockId: id,
      text,
      baseVersion: state.draftRecords[id]?.baseVersion ?? version,
      updatedAt: Date.now(),
    };
    set({
      drafts: { ...state.drafts, [id]: text },
      draftRecords: { ...state.draftRecords, [id]: record },
    });
    void recovery
      .save(record)
      .catch(() =>
        set({ recoveryError: 'Could not preserve your draft locally. Keep this tab open.' }),
      );
  },
  clearDraft: (id, text) =>
    set((s) => {
      if (s.drafts[id] !== text) return s;
      const drafts = { ...s.drafts };
      delete drafts[id];
      const draftRecords = { ...s.draftRecords };
      const record = draftRecords[id];
      delete draftRecords[id];
      if (record)
        void recovery
          .remove(record.key)
          .catch(() => set({ recoveryError: 'Could not clear the saved local draft.' }));
      return { drafts, draftRecords, recovered: s.recovered.filter((blockId) => blockId !== id) };
    }),
  addReferences: (ids) => set((s) => ({ references: [...new Set([...s.references, ...ids])] })),
  setReferences: (references) => set({ references }),
  setContinue: (continueFrom) => set({ continueFrom }),
  setTool: (tool) => set({ tool }),
  setInspector: (inspector) => set({ inspector }),
  resetContext: () => set({ references: [], continueFrom: undefined, selectedPlacements: [] }),
}));
