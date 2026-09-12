import { z } from 'zod';
import { api } from './api';
import * as response from '../../shared/contracts';
import { ocrAssetSchema, ocrQuoteSchema, ocrJobSchema, ocrResultSchema } from '../../shared/ocr';
import { submissionReceipt, pdfRepresentation } from '../../shared/schemas';
import type {
  Edit,
  Geometry,
  PlacementEdit,
  SubmitRunRequest,
  SpawnArtifactRequest,
} from '../../shared/types/domain';

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
    saveText: (edit: Edit) => read(response.savedTextResponse, '/blocks/live', edit, 'PATCH'),
    placement: (id: string) => read(response.placementResponse, `/placements/${id}`),
    savePlacement: (id: string, edit: PlacementEdit) =>
      read(response.placementResponse, `/placements/${id}`, edit, 'PATCH'),
    createPlacement: (braneId: string, blockId: string, geometry: Geometry) =>
      read(response.placementResponse, '/placements', { braneId, blockId, geometry }),
    removePlacement: (id: string) => request(`/placements/${id}`, undefined, 'DELETE'),
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
    ocrAsset: (id: string) => read(ocrAssetSchema, `/assets/${id}/ocr`),
    ocrQuote: (id: string) => read(ocrQuoteSchema, `/assets/${id}/ocr/quote`, {}),
    ocrSubmit: (id: string, policyId: string) =>
      read(ocrJobSchema, `/assets/${id}/ocr`, { key: `ocr:${id}:${policyId}`, policyId }),
    ocrJob: (id: string) => read(ocrJobSchema, `/ocr/jobs/${id}`),
    ocrResult: (id: string) => read(ocrResultSchema.nullable(), `/ocr/jobs/${id}/result`),
    ocrCancel: (id: string) => request(`/ocr/jobs/${id}/cancel`, {}),
    ocrApply: (id: string, blockId: string, version: number) =>
      read(z.object({ version: z.number().int().nonnegative() }), `/ocr/jobs/${id}/apply`, {
        blockId,
        version,
      }),
    importWebpage: (braneId: string, url: string) =>
      read(response.createdBlockResponse, '/ingest', { braneId, url }),
    importFile: (body: FormData) => read(response.importReceiptResponse, '/imports', body),
    importStatus: (key: string) => read(response.importStatusResponse, `/imports/${key}`),
    session: () => read(response.sessionResponse, '/auth/get-session'),
    signIn: (body: { email: string; password: string }) => request('/auth/sign-in/email', body),
    signUp: (body: { name: string; email: string; password: string }) =>
      request('/auth/sign-up/email', body),
    signOut: () => request('/auth/sign-out', {}),
  };
}
export type Client = ReturnType<typeof createClient>;
export const client = createClient(api);
