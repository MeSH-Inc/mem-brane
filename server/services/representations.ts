import { z } from 'zod';
import { decodeJson, decodeRecord } from '../db/records.js';
import { pdfSummaryResponse } from '../../shared/contracts.js';
import { pdfRepresentation } from '../../shared/schemas/index.js';
import { canonicalJson, representationId } from '../domain/canonical.js';
import type { DB } from '../db/index.js';
import type { Content, WorkspaceContent, PdfRepresentation } from '../../shared/types/domain.js';
import { content as contentSchema } from '../../shared/schemas/index.js';
import { DomainError, requireOwned } from '../domain/access.js';

// DTOs expand for consumers; persisted binary content pins only immutable identities.
export function encodeContent(db: DB, actor: string, content: Content): string {
  if (content.format !== 'image' && content.format !== 'pdf') return JSON.stringify(content);
  content = contentSchema.parse(content);
  if (content.format !== 'image' && content.format !== 'pdf')
    throw new Error('Expected binary content');
  const asset = requireOwned(db, 'assets', actor, content.assetId);
  if (asset.digest !== content.assetHash || asset.mime !== content.mimeType)
    throw new DomainError(409, 'Asset metadata does not match canonical bytes');
  const {
    format,
    text,
    filename,
    assetId,
    assetHash: _hash,
    mimeType: _mime,
    ...payload
  } = content;
  const json = canonicalJson(payload);
  const id = representationId(assetId, format, json);
  const existing = db.prepare('SELECT id FROM asset_representations WHERE id=?').get(id);
  if (!existing)
    db.prepare('INSERT INTO asset_representations VALUES (?,?,?,?)').run(id, assetId, format, json);
  return JSON.stringify({ format, text, filename, representationId: id });
}

export function decodeContent(db: DB, json: string): Content {
  const stored = decodeJson(storedContent, json);
  if (stored.format === 'text' || stored.format === 'webpage') return stored;
  const row = db
    .prepare(
      `SELECT r.format,r.payload_json,a.id asset_id,a.digest,a.mime
    FROM asset_representations r JOIN assets a ON a.id=r.asset_id WHERE r.id=?`,
    )
    .get(stored.representationId) as
    | { format: string; payload_json: string; asset_id: string; digest: string; mime: string }
    | undefined;
  if (!row || row.format !== stored.format)
    throw new Error('Missing or mismatched content representation');
  return decodeRecord(contentSchema, {
    format: row.format,
    text: stored.text,
    filename: stored.filename,
    assetId: row.asset_id,
    assetHash: row.digest,
    mimeType: row.mime,
    ...decodeJson(z.record(z.string(), z.unknown()), row.payload_json),
  });
}

export function readPdfPages(db: DB, actor: string, id: string): PdfRepresentation {
  const row = db
    .prepare(
      `SELECT r.payload_json FROM asset_representations r JOIN assets a ON a.id=r.asset_id
    WHERE r.id=? AND a.owner_id=? AND r.format='pdf'`,
    )
    .get(id, actor) as { payload_json: string } | undefined;
  if (!row) throw new DomainError(404, 'PDF representation not found');
  return decodeJson(z.object({ representation: pdfRepresentation }), row.payload_json)
    .representation;
}

// Request-scoped: reuse immutable payloads without retaining them across requests.
export function contentReader(
  db: DB,
  actor: string,
  projection: 'full',
): {
  prefetch(jsons: string[]): void;
  read(json: string): Content;
};
export function contentReader(
  db: DB,
  actor: string,
  projection: 'workspace',
): {
  prefetch(jsons: string[]): void;
  read(json: string): WorkspaceContent;
};
export function contentReader(db: DB, actor: string, projection: 'full' | 'workspace') {
  const payloads = new Map<string, Content | WorkspaceContent>();
  const parsed = new Map<string, z.infer<typeof storedContent>>();
  const parse = (json: string) => {
    let value = parsed.get(json);
    if (!value) {
      value = decodeJson(storedContent, json);
      parsed.set(json, value);
    }
    return value;
  };
  const prefetch = (jsons: string[]) => {
    const ids = [
      ...new Set(
        jsons
          .map(parse)
          .flatMap((c) => (c.format === 'image' || c.format === 'pdf' ? [c.representationId] : [])),
      ),
    ].filter((id) => !payloads.has(id));
    if (!ids.length) return;
    const rows = db
      .prepare(
        `SELECT r.id,r.format,${projection === 'full' ? 'r.payload_json' : 's.summary_json'} payload_json,a.id asset_id,a.digest,a.mime
      FROM asset_representations r ${projection === 'workspace' ? 'JOIN representation_summaries s ON s.representation_id=r.id' : ''}
      JOIN assets a ON a.id=r.asset_id WHERE r.id IN (SELECT value FROM json_each(?)) AND a.owner_id=?`,
      )
      .all(JSON.stringify(ids), actor) as {
      id: string;
      format: 'image' | 'pdf';
      payload_json: string;
      asset_id: string;
      digest: string;
      mime: string;
    }[];
    for (const row of rows) {
      const base = {
        format: row.format,
        text: '',
        filename: '',
        assetId: row.asset_id,
        assetHash: row.digest,
        mimeType: row.mime,
        ...decodeJson(z.record(z.string(), z.unknown()), row.payload_json),
      };
      payloads.set(
        row.id,
        projection === 'workspace' && row.format === 'pdf'
          ? decodeRecord(pdfSummaryResponse, { ...base, representationId: row.id })
          : decodeRecord(contentSchema, base),
      );
    }
    if (ids.some((id) => !payloads.has(id))) throw new DomainError(404, 'Representation not found');
  };
  return {
    prefetch,
    read(json: string) {
      const stored = parse(json);
      if (stored.format === 'text' || stored.format === 'webpage') return stored;
      prefetch([json]);
      const payload = payloads.get(stored.representationId)!;
      if (payload.format !== stored.format) throw new Error('Mismatched content representation');
      return { ...payload, text: stored.text, filename: stored.filename };
    },
  };
}

const storedContent = z.union([
  contentSchema.options[0],
  contentSchema.options[1],
  z.object({
    format: z.enum(['image', 'pdf']),
    text: z.string(),
    filename: z.string(),
    representationId: z.string(),
  }),
]);
