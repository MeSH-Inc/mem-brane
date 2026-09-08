export type BlockKind = 'text' | 'image' | 'webpage' | 'pdf';
export type RunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';
export interface TextContent {
  format: 'text';
  text: string;
  url?: never;
  assetId?: never;
  assetHash?: never;
  mimeType?: never;
  status?: never;
  error?: never;
}
export interface WebpageContent {
  format: 'webpage';
  text: string;
  url?: string;
  status: 'pending' | 'ready' | 'failed';
  error?: string;
  assetId?: never;
  assetHash?: never;
  mimeType?: never;
}
export interface ImageContent {
  format: 'image';
  text: string;
  filename: string;
  assetId: string;
  assetHash: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width?: number;
  height?: number;
  frames?: number;
  representation: 'original-image-v1';
  url?: never;
  status?: never;
  error?: never;
}
export type PdfRepresentation = {
  kind: 'pdf-text-v1';
  extractor: string;
} & (
  | { status: 'ready'; pages: { number: number; text: string }[] }
  | { status: 'unavailable'; reason: string }
);
export interface PdfContent {
  format: 'pdf';
  text: string;
  filename: string;
  assetId: string;
  assetHash: string;
  mimeType: 'application/pdf';
  pageCount: number;
  representation: PdfRepresentation;
  url?: never;
  status?: never;
  error?: never;
}
export type Content = TextContent | WebpageContent | ImageContent | PdfContent;
export interface Brane {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}
export interface Block {
  id: string;
  kind: BlockKind;
  origin: 'authored' | 'generated';
  content: Content;
  version: number;
  messageId?: string;
}
export interface Revision {
  id: string;
  block_id: string;
  content: Content;
  created_at: number;
}
export type Geometry = { x: number; y: number; width: number; height: number };
export interface Placement {
  version: number;
  id: string;
  brane_id: string;
  block_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
}
export interface Run {
  id: string;
  brane_id: string;
  status: RunStatus;
  model: string;
  provider: string;
  output_block_id: string;
  partial: string;
  error: string | null;
  usage_json: string | null;
  retry_of: string | null;
  created_at: number;
}
export interface BraneState {
  brane: Brane;
  blocks: Block[];
  placements: Placement[];
  runs: Run[];
  derivations: Derivation[];
}
export interface RunInput {
  position: number;
  kind: 'source' | 'reference' | 'lineage_reference' | 'lineage' | 'prompt';
  label: string;
  role: 'user' | 'assistant';
  revision_id: string;
  content: Content;
}
export interface Edit {
  blockId: string;
  text: string;
  version: number;
}
export interface SubmitRun {
  braneId: string;
  key: string;
  model: string;
  prompt: string;
  references: string[];
  continueFrom?: string;
  edits: Edit[];
  maxOutputTokens?: number;
}

export interface Derivation {
  runId: string;
  sourceBlockId: string;
  sourceRevisionId: string;
  outputBlockId: string;
  position: number;
  anchorPlacementId: string | null;
  outputPlacementId: string | null;
}
export interface SpawnArtifact {
  braneId: string;
  key: string;
  sourceBlockIds: string[];
  anchorPlacementId: string;
  action: 'develop';
  model: string;
  edits: Edit[];
}
