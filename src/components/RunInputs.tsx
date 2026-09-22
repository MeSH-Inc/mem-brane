import type { RunDetail } from '../../shared/contracts';
import { formatUsd } from '../lib/format';
import { statusLabels } from '../lib/labels';
import { Dialog } from './Dialog';
import { LocalImage } from './LocalAsset';
import { PdfContent } from './PdfContent';

// The frozen inputs a run was sent, addressable by URL (?inputs=<runId>).
export function RunInputs({
  runId,
  run,
  error,
  outputPresent,
  onOpenOutput,
  onClose,
}: {
  runId: string;
  run?: RunDetail;
  error?: string;
  outputPresent: boolean;
  onOpenOutput: (blockId: string) => void;
  onClose: () => void;
}) {
  const loaded = run?.id === runId ? run : undefined;
  return (
    <Dialog title="Exact inputs" className="run-inputs" onClose={onClose}>
      <aside className="inspector frozen-inspector">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : !loaded ? (
          <p>Loading exact inputs…</p>
        ) : (
          <>
            <p>
              {new Date(loaded.created_at).toLocaleString()} · {loaded.model} ·{' '}
              {statusLabels[loaded.status] ?? loaded.status}
              {loaded.retry_of ? ' · retry' : ''}
            </p>
            {loaded.cost && (
              <p className="cost-detail">
                {loaded.cost.status === 'confirmed'
                  ? `Cost: ${formatUsd(loaded.cost.confirmed_microusd ?? 0)}`
                  : `Cost not yet confirmed · up to ${formatUsd(loaded.cost.reserved_microusd)} held`}
              </p>
            )}
            {outputPresent ? (
              <button className="text-button" onClick={() => onOpenOutput(loaded.output_block_id)}>
                Open response
              </button>
            ) : (
              <p>The response is no longer on this brane.</p>
            )}
            {loaded.inputs.map((input) => (
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
                    <small>Frozen image · low detail · SHA-256 {input.content.assetHash}</small>
                  </>
                )}
              </details>
            ))}
          </>
        )}
      </aside>
    </Dialog>
  );
}
