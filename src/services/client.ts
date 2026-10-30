import { signupPolicyResponse } from '../../shared/auth';
import { z } from 'zod';
import { api } from './api';
import * as response from '../../shared/contracts';
import { submissionReceipt, pdfRepresentation } from '../../shared/schemas';
import type {
  Edit,
  Geometry,
  Group,
  PlacementEdit,
  SubmitRunRequest,
  SpawnArtifactRequest,
} from '../../shared/types/domain';
import type { RunMachineRequest } from '../../shared/machines';

// A group stated whole: its label, display and members in member order.
interface GroupBody {
  braneId: string;
  label: string;
  display: Group['display'];
  members: string[];
}

export class InvalidApiResponse extends Error {
  constructor(path: string, cause: unknown) {
    super(`Invalid server response for ${path}`, { cause });
  }
}
// Only this decoder promotes untrusted transport data to a response type.
export function createClient(request: typeof api) {
  async function read<T>(
    schema: z.ZodType<T>,
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<T> {
    const result = schema.safeParse(await request(path, body, method));
    if (!result.success) throw new InvalidApiResponse(path, result.error);
    return result.data;
  }
  const page = (path: string, cursor?: string) =>
    cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
  return {
    configuration: () => read(response.configurationResponse, '/config'),
    budget: () => read(response.budgetResponse, '/budget'),
    workspace: (id: string) => read(response.workspaceResponse, `/branes/${id}`),
    branes: () => read(z.array(response.braneResponse), '/branes'),
    createBrane: (title: string) => read(response.braneResponse, '/branes', { title }),
    saveTitle: (braneId: string, title: string) =>
      request(`/branes/${braneId}`, { title }, 'PATCH'),
    createText: (braneId: string, geometry: Geometry) =>
      read(response.createdBlockResponse, '/blocks/text', { braneId, geometry }),
    createMachine: (braneId: string, geometry: Geometry, template?: string) =>
      read(response.createdBlockResponse, '/blocks/machine', { braneId, geometry, template }),
    createFeed: (body: {
      braneId: string;
      fromPlacementId?: string;
      fromGroupId?: string;
      toPlacementId: string;
      slot: string;
    }) => request('/feeds', body),
    setFeedMode: (id: string, braneId: string, mode: 'together' | 'each') =>
      request(`/feeds/${id}`, { braneId, mode }, 'PATCH'),
    removeFeed: (id: string) => request(`/feeds/${id}`, undefined, 'DELETE'),
    workshop: () => read(response.workshopResponse, '/workshop'),
    saveToWorkshop: (name: string, template: string) => request('/workshop', { name, template }),
    removeFromWorkshop: (id: string) => request(`/workshop/${id}`, undefined, 'DELETE'),
    createRelation: (body: {
      braneId: string;
      fromPlacementId: string;
      toPlacementId: string;
      label: string;
    }) => request('/relations', body),
    relabelRelation: (id: string, braneId: string, label: string) =>
      request(`/relations/${id}`, { braneId, label }, 'PATCH'),
    removeRelation: (id: string) => request(`/relations/${id}`, undefined, 'DELETE'),
    createGroup: (body: GroupBody) => request('/groups', body),
    editGroup: (id: string, body: GroupBody) => request(`/groups/${id}`, body, 'PATCH'),
    removeGroup: (id: string) => request(`/groups/${id}`, undefined, 'DELETE'),
    runMachine: (input: RunMachineRequest) => read(submissionReceipt, '/machines/run', input),
    estimateMachine: (input: RunMachineRequest) =>
      read(response.estimateResponse, '/machines/estimate', input),
    block: (id: string) => read(response.blockResponse, `/blocks/${id}`),
    unplacedCards: (cursor?: string) =>
      read(response.unplacedPageResponse, page('/blocks/unplaced', cursor)),
    saveText: (edit: Edit) => read(response.savedTextResponse, '/blocks/live', edit, 'PATCH'),
    placement: (id: string) => read(response.placementResponse, `/placements/${id}`),
    savePlacement: (id: string, edit: PlacementEdit) =>
      read(response.placementResponse, `/placements/${id}`, edit, 'PATCH'),
    createPlacement: (braneId: string, blockId: string, geometry: Geometry) =>
      read(response.placementResponse, '/placements', { braneId, blockId, geometry }),
    removePlacement: (id: string) => request(`/placements/${id}`, undefined, 'DELETE'),
    detachPlacement: (id: string, version: number, geometry: Geometry) =>
      read(response.placementResponse, `/placements/${id}/detach`, { version, geometry }),
    submit: (input: SubmitRunRequest) => read(submissionReceipt, '/runs', input),
    spawn: (input: SpawnArtifactRequest) => read(submissionReceipt, '/artifacts/spawn', input),
    estimate: (input: SubmitRunRequest) => read(response.estimateResponse, '/runs/estimate', input),
    run: (id: string) => read(response.runDetailResponse, `/runs/${id}`),
    runPage: (braneId: string, cursor?: string) =>
      read(response.runPageResponse, page(`/branes/${braneId}/runs`, cursor)),
    cancelRun: (id: string) => request(`/runs/${id}/cancel`, {}),
    retryRun: (id: string, key: string) =>
      read(response.runIdentityResponse, `/runs/${id}/retry`, { key }),
    lineage: (id: string) => read(response.lineageResponse, `/context/lineage/${id}`),
    revision: (id: string) => read(response.revisionResponse, `/revisions/${id}`),
    revisionPage: (blockId: string, cursor?: string) =>
      read(response.revisionPageResponse, page(`/blocks/${blockId}/revisions`, cursor)),
    snapshot: (blockId: string) =>
      read(response.revisionResponse, `/blocks/${blockId}/snapshot`, {}),
    pdfPages: (id: string) => read(pdfRepresentation, `/representations/${id}/pages`),
    importWebpage: (braneId: string, url: string) =>
      read(response.createdBlockResponse, '/ingest', { braneId, url }),
    importFile: (body: FormData) => read(response.importReceiptResponse, '/imports', body),
    importStatus: (key: string) => read(response.importStatusResponse, `/imports/${key}`),
    session: (library?: string, brane?: string) =>
      read(
        response.sessionResponse,
        library
          ? `/session?library=${encodeURIComponent(library)}`
          : brane
            ? `/session?brane=${encodeURIComponent(brane)}`
            : '/session',
      ),
    entryPolicy: () => read(z.object({ guest: z.boolean() }), '/entry-policy'),
    startGuest: () =>
      read(
        z.object({ session: response.sessionResponse, braneId: z.string() }),
        '/guest/start',
        {},
      ),
    signIn: (body: { email: string; password: string }) => request('/auth/sign-in/email', body),
    signupPolicy: () => read(signupPolicyResponse, '/signup-policy'),
    recoveryPolicy: () => read(z.object({ enabled: z.boolean() }), '/recovery-policy'),
    requestPasswordReset: (email: string) => request('/auth/request-password-reset', { email }),
    resetPassword: (token: string, newPassword: string) =>
      request('/auth/reset-password', { token, newPassword }),
    signUp: (body: { name: string; email: string; password: string; inviteCode?: string }) =>
      request('/auth/sign-up/email', body),
    signOut: () => request('/auth/sign-out', {}),
  };
}
export type Client = ReturnType<typeof createClient>;
export const client = createClient(api);
