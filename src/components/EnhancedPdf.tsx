import { useEffect, useRef, useState } from 'react';
import { client } from '../services/client';
import type { OcrAsset, OcrJob, OcrQuote, OcrResult } from '../../shared/ocr';

export function EnhancedPdf({
  assetId,
  blockId,
  version,
  appliedPolicy,
}: {
  assetId: string;
  blockId: string;
  version: number;
  appliedPolicy?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="enhanced-pdf" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Enhanced PDF extraction</summary>
      {open && (
        <Extraction
          key={`${blockId}:${assetId}`}
          assetId={assetId}
          blockId={blockId}
          version={version}
          appliedPolicy={appliedPolicy}
        />
      )}
    </details>
  );
}

function Extraction({
  assetId,
  blockId,
  version,
  appliedPolicy,
}: {
  assetId: string;
  blockId: string;
  version: number;
  appliedPolicy?: string;
}) {
  const [state, setState] = useState<OcrAsset>();
  const [quote, setQuote] = useState<OcrQuote>();
  const [job, setJob] = useState<OcrJob>();
  const [result, setResult] = useState<OcrResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string>();
  const [pollAttempt, setPollAttempt] = useState(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  const perform = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Enhanced extraction is unavailable');
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const reload = async () => {
    const next = await client.ocrAsset(assetId);
    if (!mounted.current) return;
    setState(next);
    setJob(next.job ?? undefined);
    setPollAttempt((value) => value + 1);
  };
  useEffect(() => {
    mounted.current = true;
    void perform(reload);
    return () => {
      mounted.current = false;
    };
  }, [assetId]);
  useEffect(() => {
    setResult(undefined);
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await client.ocrJob(job.id);
        if (!active) return;
        setJob(current);
        if (current.status === 'queued' || current.status === 'running')
          timer = setTimeout(poll, 2000);
        else if (current.status === 'succeeded') {
          const saved = await client.ocrResult(current.id);
          if (active) setResult(saved ?? undefined);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Cannot read parsing status');
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job?.id, pollAttempt]);
  const appliedHere = job && (appliedPolicy === job.policyId || applied === job.policyId);
  return (
    <section aria-label="Enhanced PDF extraction">
      {state && <p>{state.credits.availablePages} page credits available.</p>}
      {state && !state.enabled && (
        <p>Enhanced parsing is not enabled. Saved extractions remain available.</p>
      )}
      {!state && !error && <p>Checking parsing availability…</p>}
      {error && <p role="alert">{error}</p>}
      {error && (
        <button disabled={busy} onClick={() => void perform(reload)}>
          Refresh parsing status
        </button>
      )}
      {state?.enabled && (!job || state.currentPolicyId !== job.policyId) && !quote && (
        <>
          {job && (
            <p>
              A different parser is available. A new extraction requires a separate page-credit
              reservation.
            </p>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const next = await client.ocrQuote(assetId);
                if (!mounted.current) return;
                setQuote(next);
                setJob(next.job ?? undefined);
              })
            }
          >
            Review page credits
          </button>
        </>
      )}
      {quote && !job && (
        <div className="ocr-confirmation">
          <p>
            Send the original PDF to{' '}
            {quote.policy.provider === 'mistral' ? 'Mistral' : quote.policy.provider} for enhanced
            text extraction.
          </p>
          <p>
            {quote.pages} pages · Reserve {quote.requiredCredits} page credits from{' '}
            {quote.credits.availablePages} available.
          </p>
          <small>
            Credits remain held if processing or billing cannot be confirmed. Starting again will
            recover this request.
          </small>
          {quote.requiredCredits > quote.credits.availablePages && (
            <p>
              More page credits are needed. Contact the operator for an invitation or a verified
              credit grant.
            </p>
          )}
          <button
            disabled={busy || quote.requiredCredits > quote.credits.availablePages}
            onClick={() =>
              void perform(async () => {
                const next = await client.ocrSubmit(assetId, quote.policyId);
                if (!mounted.current) return;
                setJob(next);
                setQuote(undefined);
                const refreshed = await client.ocrAsset(assetId);
                if (mounted.current) setState(refreshed);
              })
            }
          >
            Confirm {quote.requiredCredits} page credits
          </button>
          <button disabled={busy} onClick={() => setQuote(undefined)}>
            Keep current extraction
          </button>
        </div>
      )}
      {job && (
        <>
          <p role="status">
            {job.status === 'queued'
              ? 'Waiting for enhanced extraction'
              : job.status === 'running'
                ? 'Extracting PDF text…'
                : job.status === 'succeeded'
                  ? 'Enhanced extraction ready'
                  : job.status === 'uncertain'
                    ? 'Processing or billing needs operator review'
                    : job.status === 'cancelled'
                      ? 'Enhanced extraction cancelled'
                      : 'Enhanced extraction failed'}
          </p>
          <small>
            {job.committedPages} page credits{' '}
            {['queued', 'running', 'uncertain'].includes(job.status) ? 'held' : 'used'}
          </small>
          {job.error && <p>{job.error}</p>}
          {job.status === 'uncertain' && (
            <p>
              This request will not be sent again. Contact the operator with reference {job.id}.
            </p>
          )}
          {['failed', 'cancelled'].includes(job.status) && (
            <p>
              This PDF and parser will not be submitted again. Contact the operator with reference{' '}
              {job.id} to review the recorded outcome.
            </p>
          )}
          {job.status === 'queued' && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await client.ocrCancel(job.id);
                  await reload();
                })
              }
            >
              Cancel queued extraction
            </button>
          )}
          {result && (
            <>
              {result.document.pages.map((page) => (
                <details className="pdf-page" key={page.page}>
                  <summary>Enhanced page {page.page}</summary>
                  <pre>{page.markdown || 'No text found on this page.'}</pre>
                </details>
              ))}
              {appliedHere ? (
                <p>
                  Enhanced text is used for future model context. Existing run snapshots are
                  preserved.
                </p>
              ) : (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await client.ocrApply(job.id, blockId, version);
                      if (!mounted.current) return;
                      setApplied(job.policyId);
                    })
                  }
                >
                  Use enhanced text for model context
                </button>
              )}
            </>
          )}
          <details>
            <summary>Extraction details</summary>
            <small>
              {job.policy.provider} · {job.policy.model} · {job.policy.version}
              <br />
              Reference {job.id}
            </small>
          </details>
        </>
      )}
    </section>
  );
}
