import type { PdfContent as Pdf } from '../../shared/types/domain';
export function PdfContent({
  content,
  showProvenance = false,
}: {
  content: Pdf;
  showProvenance?: boolean;
}) {
  const representation = content.representation;
  return (
    <div className="pdf-content nodrag nowheel nopan">
      <a href={`/api/assets/${content.assetId}`} download={content.filename}>
        Download original PDF ↗
      </a>
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
          {representation.pages.map((page) => (
            <details key={page.number} className="pdf-page">
              <summary>
                Page {page.number}
                {!page.text && ' · no extractable text'}
              </summary>
              <pre>{page.text || 'This page needs OCR or visual interpretation.'}</pre>
            </details>
          ))}
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
