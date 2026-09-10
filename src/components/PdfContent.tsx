import { useAssetUrl } from './LocalAsset';
import { useEffect, useState } from 'react';
import { client } from '../services/client';
import type { PdfContent as Pdf, PdfSummary, PdfRepresentation } from '../../shared/types/domain';
export function PdfContent({
  content,
  showProvenance = false,
}: {
  content: Pdf | PdfSummary;
  showProvenance?: boolean;
}) {
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
    <div className="pdf-content nodrag nowheel nopan">
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
              <details key={page.number} className="pdf-page">
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
    </div>
  );
}
