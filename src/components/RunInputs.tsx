import type { RunDetail } from '../../shared/contracts';
import type { Revision } from '../../shared/types/domain';
import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '../lib/format';
import { statusLabels } from '../lib/labels';
import { client } from '../services/client';
import type { CommandTasks } from '../services/command-tasks';
import { CommandButton } from './CommandButton';
import { Dialog } from './Dialog';
import { LocalImage } from './LocalAsset';
import { PdfContent } from './PdfContent';

// The frozen inputs a run was sent, addressable by URL (?inputs=<runId>).
export function RunInputs({
  runId,
  run,
  error,
  outputPresent,
  commands,
  onShowHere,
  onOpenOutput,
  onClose,
}: {
  runId: string;
  run?: RunDetail;
  error?: string;
  outputPresent: boolean;
  commands: CommandTasks;
  onShowHere: (blockId: string) => Promise<void>;
  onOpenOutput: (blockId: string) => void;
  onClose: () => void;
}) {
  const loaded = run?.id === runId ? run : undefined;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [response, setResponse] = useState<Revision>();
  const [previewError, setPreviewError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const request = useRef(0);
  const activeRun = useRef(runId);
  useEffect(() => {
    activeRun.current = runId;
    setPreviewOpen(false);
    setResponse(undefined);
    setPreviewError('');
    setRestoreError('');
    return () => {
      activeRun.current = '';
      request.current++;
    };
  }, [runId]);
  async function preview() {
    const generation = ++request.current;
    setPreviewOpen(true);
    setPreviewError('');
    if (!loaded?.output || response?.id === loaded.output.revision_id) return;
    try {
      const revision = await client.revision(loaded.output.revision_id);
      if (generation === request.current) setResponse(revision);
    } catch (error) {
      if (generation === request.current) setPreviewError((error as Error).message);
    }
  }
  async function restore() {
    if (!loaded) return;
    setRestoreError('');
    try {
      await onShowHere(loaded.output_block_id);
      if (activeRun.current === runId) onOpenOutput(loaded.output_block_id);
    } catch (error) {
      if (activeRun.current === runId) setRestoreError((error as Error).message);
    }
  }
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
              <section className="response-recovery" aria-label="Removed response">
                <p>The response is no longer on this brane.</p>
                <div className="artifact-row">
                  <button onClick={() => void preview()}>Preview saved response</button>
                  <CommandButton
                    tasks={commands}
                    taskKey={`restore:${loaded.output_block_id}`}
                    pendingLabel="Showing…"
                    onClick={() => void restore()}
                  >
                    Show response here
                  </CommandButton>
                </div>
                {restoreError && <p role="alert">{restoreError}</p>}
                {previewOpen && (
                  <section className="card-preview" aria-label="Saved response preview">
                    {previewError ? (
                      <>
                        <p role="alert">{previewError}</p>
                        <button onClick={() => void preview()}>Retry response preview</button>
                      </>
                    ) : loaded.output ? (
                      response?.id === loaded.output.revision_id ? (
                        <>
                          <strong>Saved response</strong>
                          <code>{response.id}</code>
                          <pre>{response.content.text}</pre>
                        </>
                      ) : (
                        <p role="status">Loading saved response…</p>
                      )
                    ) : loaded.checkpoint ? (
                      <>
                        <strong>Saved partial response</strong>
                        <small>{new Date(loaded.checkpoint.updated_at).toLocaleString()}</small>
                        <pre>{loaded.checkpoint.text}</pre>
                      </>
                    ) : (
                      <p>No saved response text yet.</p>
                    )}
                  </section>
                )}
              </section>
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
