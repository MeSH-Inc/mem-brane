import { canonicalJson, representationId } from '../domain/canonical.js';
import type { DB } from '../db/index.js';
import type {
  Content,
  WorkspaceContent,
  PdfSummary,
  PdfRepresentation,
} from '../../shared/types/domain.js';
import { content as contentSchema } from '../../shared/schemas/index.js';
import { DomainError, requireOwned } from '../domain/access.js';

// DTOs expand for consumers; persisted binary content pins only immutable identities.
export function encodeContent(db: DB, actor: string, content: Content): string {
  if (content.format !== 'image' && content.format !== 'pdf') return JSON.stringify(content);
  content = contentSchema.parse(content) as typeof content;
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
  const stored = JSON.parse(json);
  if (stored.format !== 'image' && stored.format !== 'pdf') return stored;
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
  return contentSchema.parse({
    format: row.format,
    text: stored.text,
    filename: stored.filename,
    assetId: row.asset_id,
    assetHash: row.digest,
    mimeType: row.mime,
    ...JSON.parse(row.payload_json),
  });
}

export function decodeWorkspaceContent(db: DB, json: string): WorkspaceContent {
  const stored = JSON.parse(json);
  if (stored.format !== 'pdf') return decodeContent(db, json) as WorkspaceContent;
  const row = db
    .prepare(
      `SELECT s.summary_json,a.id asset_id,a.digest,a.mime FROM representation_summaries s
    JOIN asset_representations r ON r.id=s.representation_id JOIN assets a ON a.id=r.asset_id
    WHERE r.id=? AND r.format='pdf'`,
    )
    .get(stored.representationId) as
    { summary_json: string; asset_id: string; digest: string; mime: 'application/pdf' } | undefined;
  if (!row) throw new Error('Missing PDF summary');
  return {
    format: 'pdf',
    text: stored.text,
    filename: stored.filename,
    representationId: stored.representationId,
    assetId: row.asset_id,
    assetHash: row.digest,
    mimeType: row.mime,
    ...JSON.parse(row.summary_json),
  } as PdfSummary;
}
export function readPdfPages(db: DB, actor: string, id: string): PdfRepresentation {
  const row = db
    .prepare(
      `SELECT r.payload_json FROM asset_representations r JOIN assets a ON a.id=r.asset_id
    WHERE r.id=? AND a.owner_id=? AND r.format='pdf'`,
    )
    .get(id, actor) as { payload_json: string } | undefined;
  if (!row) throw new DomainError(404, 'PDF representation not found');
  return JSON.parse(row.payload_json).representation;
}
