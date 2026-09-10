import { useEffect, useState } from 'react';

export function AppStatus() {
  const [connected, setConnected] = useState(navigator.onLine);
  const [update, setUpdate] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const online = () => setConnected(true);
    const offline = () => setConnected(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    let disposed = false;
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((registration) => {
          const check = () => {
            if (!disposed) setUpdate(!!registration.waiting);
          };
          check();
          registration.addEventListener('updatefound', () => {
            registration.installing?.addEventListener('statechange', check);
          });
        })
        .catch(() => {
          if (!disposed)
            setProblem('Offline app installation failed. Reconnect and reload to retry.');
        });
    }
    return () => {
      disposed = true;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);
  if (connected && !update && !problem) return null;
  return (
    <aside className="app-status" aria-label="App connection and updates">
      {!connected && <p>Disconnected. Reconnect to synchronize your workspace and use AI.</p>}
      {problem && <p>{problem}</p>}
      {update && (
        <p>An app update is ready. Close all mem-brane windows and reopen to install it.</p>
      )}
    </aside>
  );
}
