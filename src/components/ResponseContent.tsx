import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Run } from '../../shared/types/domain';

export type ResponseActions = {
  onStop?: (id: string) => Promise<unknown>;
  onRetry?: (id: string) => Promise<unknown>;
};
const progress: Record<string, string> = {
  queued: 'Waiting to start…',
  claimed: 'Starting…',
  running: 'Writing…',
  cancel_requested: 'Stopping…',
  failed: 'Response failed',
  interrupted: 'Response interrupted',
  cancelled: 'Response stopped',
};
export function ResponseContent({
  text,
  run,
  onStop,
  onRetry,
}: ResponseActions & { text: string; run?: Run }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const active = !!run && ['queued', 'claimed', 'running', 'cancel_requested'].includes(run.status);
  const incomplete = !!run && ['failed', 'interrupted', 'cancelled'].includes(run.status);
  const content = text || run?.partial || '';
  async function act(action: () => Promise<unknown>) {
    setPending(true);
    setNotice('');
    try {
      await action();
    } catch {
      setNotice('Could not complete that action. Please try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="response-content nodrag nowheel nopan">
        {content ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
              img: ({ alt }) => <span>{alt || 'Image'}</span>,
            }}
          >
            {content}
          </Markdown>
        ) : (
          <p className="muted">
            {active ? 'Your response will appear here.' : 'No response text was saved.'}
          </p>
        )}
      </div>
      <div className="response-controls nodrag nopan nowheel">
        {run && run.status !== 'completed' && <span role="status">{progress[run.status]}</span>}
        {active && onStop && (
          <button
            disabled={pending || run.status === 'cancel_requested'}
            onClick={() => void act(() => onStop(run.id))}
          >
            Stop
          </button>
        )}
        {incomplete && onRetry && (
          <button
            disabled={pending}
            title="Creates a new response from the same inputs; may incur a new charge."
            onClick={() => void act(() => onRetry(run.id))}
          >
            {pending ? 'Retrying…' : 'Try again'}
          </button>
        )}
        {content && (
          <button
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(content);
                setNotice('Copied');
              })
            }
          >
            Copy
          </button>
        )}
        {incomplete && (
          <small>
            {run.error || 'Any partial text is kept. Try again to create a new response.'}
          </small>
        )}
        {notice && <small role="status">{notice}</small>}
      </div>
    </>
  );
}
