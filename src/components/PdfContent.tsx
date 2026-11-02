import { useAssetUrl } from './LocalAsset';
import { useEffect, useRef, useState } from 'react';
import { isQuoteKey, QuoteButton, type Passage } from './BlockContent';
import { client } from '../services/client';
import type { PdfContent as Pdf, PdfSummary, PdfRepresentation } from '../../shared/types/domain';
export function PdfContent({
  content,
  showProvenance = false,
  onQuote,
}: {
  content: Pdf | PdfSummary;
  showProvenance?: boolean;
  onQuote?: (passage: Passage) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The passage selected in this PDF's page text, and its page.
  const [selected, setSelected] = useState<Passage>();
  useEffect(() => {
    if (!onQuote) return;
    const read = () => {
      const selection = globalThis.document.getSelection();
      const anchor = selection?.anchorNode;
      const text = selection?.toString().trim();
      if (
        !selection ||
        selection.isCollapsed ||
        !text ||
        !anchor ||
        !host.current?.contains(anchor)
      )
        return setSelected(undefined);
      const page = (
        anchor instanceof Element ? anchor : anchor.parentElement
      )?.closest<HTMLElement>('[data-page]')?.dataset.page;
      setSelected({ text, ...(page ? { page: Number(page) } : {}) });
    };
    globalThis.document.addEventListener('selectionchange', read);
    return () => globalThis.document.removeEventListener('selectionchange', read);
  }, [onQuote]);
  const quote = () => {
    if (!selected || !onQuote) return;
    onQuote(selected);
    globalThis.document.getSelection()?.removeAllRanges();
    setSelected(undefined);
  };
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  useEffect(() => {
    if (!selected) return;
    // Page text cannot hold focus, so Q is heard from the page while a passage is selected.
    const press = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]') || !isQuoteKey(event))
        return;
      event.preventDefault();
      event.stopPropagation();
      quoteRef.current();
    };
    globalThis.addEventListener('keydown', press, true);
    return () => globalThis.removeEventListener('keydown', press, true);
  }, [selected]);
  const original = useAssetUrl(content.assetId);
  const identity = 'representationId' in content ? content.representationId : undefined;
  const [loaded, setLoaded] = useState<{ id: string; value: PdfRepresentation }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [requested, setRequested] = useState<string>();
  useEffect(() => {
    setError('');
    if (!identity || requested !== identity) return;
    let active = true;
    client
      .pdfPages(identity)
      .then((value) => {
        if (active) setLoaded({ id: identity, value });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [identity, requested, attempt]);
  const representation =
    identity && loaded?.id === identity ? loaded.value : content.representation;
  return (
    <div ref={host} className="pdf-content nodrag nowheel nopan">
      <a href={original.url} download={content.filename}>
        Download original PDF ↗
      </a>
      {original.error && <p>{original.error}</p>}
      <strong>{content.filename}</strong>
      <small>
        {content.pageCount} {content.pageCount === 1 ? 'page' : 'pages'} · original retained
      </small>
      {representation.status === 'ready' ? (
        <>
          <p className="representation-notice">
            Model context uses extracted text by page. Images, diagrams and visual layout are not
            included.
          </p>
          {representation.pages ? (
            representation.pages.map((page) => (
              <details key={page.number} className="pdf-page" data-page={page.number}>
                <summary>
                  Page {page.number}
                  {!page.text && ' · no extractable text'}
                </summary>
                <pre>{page.text || 'This page needs OCR or visual interpretation.'}</pre>
              </details>
            ))
          ) : (
            <button
              type="button"
              disabled={requested === identity && !error}
              onClick={() => {
                setRequested(identity);
                setAttempt((n) => n + 1);
              }}
            >
              {error
                ? 'Retry loading page text'
                : requested === identity
                  ? 'Loading page text…'
                  : 'Load page text'}
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          {showProvenance && (
            <small>
              Text representation · {representation.extractor} · SHA-256 {content.assetHash}
            </small>
          )}
        </>
      ) : (
        <p className="error">Not available as model context: {representation.reason}</p>
      )}
      {selected && onQuote && <QuoteButton onQuote={quote} />}
    </div>
  );
}
