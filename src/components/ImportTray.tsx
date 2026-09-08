import { useEffect, useState } from 'react';
import { imports, type ImportTask } from '../services/imports';
function Preview({ task }: { task: ImportTask }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!task.blob || !task.mime.startsWith('image/')) return;
    const url = URL.createObjectURL(task.blob);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [task.blob, task.mime]);
  return task.blob && url ? (
    <img src={url} alt={`Preview of ${task.filename}`} />
  ) : (
    <span className="import-file-icon">▧</span>
  );
}
export function ImportTray({ tasks }: { tasks: ImportTask[] }) {
  return (
    <section className="import-tray" aria-label="File imports">
      {tasks.map((task) => (
        <div key={task.id} className={`import-item ${task.status}`}>
          <Preview task={task} />
          <div>
            <strong>{task.filename}</strong>
            <small>
              {task.status === 'ready'
                ? task.intent.target === 'composer'
                  ? 'Saved · added to prompt context'
                  : 'Saved to canvas'
                : task.status === 'uploading'
                  ? 'Uploading and validating…'
                  : task.status === 'saving'
                    ? 'Preserving file…'
                    : task.status === 'queued'
                      ? 'Waiting to upload…'
                      : task.error}
            </small>
          </div>
          {['uncertain', 'failed'].includes(task.status) && (
            <button onClick={() => void imports.retry(task.id)}>Retry import</button>
          )}
          {['ready', 'failed', 'rejected'].includes(task.status) && (
            <button
              aria-label={`Dismiss ${task.filename}`}
              onClick={() => void imports.dismiss(task.id).catch(() => {})}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
