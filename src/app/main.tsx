import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  Link,
  useNavigate,
} from '@tanstack/react-router';
import { z } from 'zod';
import { api } from '../services/api';
import { useInteraction } from '../stores/interaction';
import { BraneView } from '../routes/BraneView';
import type { Brane } from '../../shared/types/domain';
import './styles.css';
function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [signup, setSignup] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth-screen">
      <div className="auth-art">
        <div className="brand-mark">
          m<span>·</span>b
        </div>
        <span className="eyebrow">MEM-BRANE / A SPATIAL NOTEBOOK</span>
        <h1>
          Give your thoughts
          <br />a little more room.
        </h1>
        <p>
          A place to collect, connect, and explore.
          <br />
          One brane. Many possibilities.
        </p>
        <div className="art-note one">
          What if…<i>an idea could take shape?</i>
        </div>
        <div className="art-note two">
          ◇<i>Make space for the unexpected.</i>
        </div>
        <span className="auth-footnote">YOUR IDEAS, AT YOUR OWN PACE.</span>
      </div>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const form = new FormData(e.currentTarget);
          try {
            await api(`/auth/${signup ? 'sign-up' : 'sign-in'}/email`, {
              email: form.get('email'),
              password: form.get('password'),
              ...(signup ? { name: form.get('name') } : {}),
            });
            onSignedIn();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">WELCOME TO MEM-BRANE</span>
        <h2>{signup ? 'Start thinking here.' : 'Pick up a thought.'}</h2>
        <p>
          {signup ? 'Create your own space for ideas.' : 'Sign in to your personal thinking space.'}
        </p>
        {signup && (
          <label>
            Name
            <input name="name" required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete={signup ? 'new-password' : 'current-password'}
            placeholder="At least 12 characters"
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button disabled={busy} className="primary">
          {busy ? 'One moment…' : signup ? 'Create your space ↗' : 'Open your space ↗'}
        </button>
        <button type="button" className="text-button" onClick={() => setSignup(!signup)}>
          {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </form>
    </main>
  );
}
function Shell() {
  const [session, setSession] = useState<any>(undefined),
    [branes, setBranes] = useState<Brane[]>([]),
    [error, setError] = useState('');
  const navigate = useNavigate();
  const refreshSession = () =>
    void api('/auth/get-session')
      .then(async (value) => {
        if (value?.user) await useInteraction.getState().initialize(value.user.id);
        setSession(value);
        setError('');
      })
      .catch(() => setError('The server is unavailable. Reconnect to open your workspace.'));
  const refreshBranes = () =>
    void api<Brane[]>('/branes')
      .then(setBranes)
      .catch((e) => setError(e.message));
  useEffect(() => {
    refreshSession();
    window.addEventListener('brane:session-expired', refreshSession);
    return () => window.removeEventListener('brane:session-expired', refreshSession);
  }, []);
  useEffect(() => {
    if (!session) return;
    refreshBranes();
    const events = new EventSource('/api/events');
    events.addEventListener('ready', () => window.dispatchEvent(new Event('brane:reconcile')));
    events.addEventListener('run', (event) =>
      window.dispatchEvent(
        new CustomEvent('brane:run', { detail: JSON.parse((event as MessageEvent).data) }),
      ),
    );
    window.addEventListener('brane:reconcile', refreshBranes);
    const timer = setInterval(refreshBranes, 10000);
    return () => {
      events.close();
      window.removeEventListener('brane:reconcile', refreshBranes);
      clearInterval(timer);
    };
  }, [session]);
  if (session === undefined)
    return (
      <div className="loading">
        {error || 'Opening mem-brane…'}
        {error && <button onClick={refreshSession}>Reconnect</button>}
      </div>
    );
  if (!session) return <AuthScreen onSignedIn={refreshSession} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="wordmark">
          mem-brane
          <span className="brand-dot" />
        </Link>
        <span className="sidebar-subtitle">ROOM FOR THOUGHT</span>
        <button
          className="new-brane"
          onClick={async () => {
            try {
              const b = await api<Brane>('/branes', { title: 'Untitled brane' });
              refreshBranes();
              await navigate({ to: '/b/$braneId', params: { braneId: b.id } });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          ＋ New brane <span>↗</span>
        </button>
        <div className="section-label">
          YOUR BRANES <span>{branes.length.toString().padStart(2, '0')}</span>
        </div>
        <nav className="brane-nav">
          {branes.map((b, i) => (
            <Link
              to="/b/$braneId"
              params={{ braneId: b.id }}
              key={b.id}
              activeProps={{ className: 'active' }}
            >
              <span>◇</span>
              <div>
                {b.title}
                <small>
                  {new Date(b.updated_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </small>
              </div>
              <span className="brane-index">{String(i + 1).padStart(2, '0')}</span>
            </Link>
          ))}
        </nav>
        {error && <p className="error">{error}</p>}
        <div className="sidebar-note">
          <span>✳</span>
          <p>
            Collect a thought.
            <br />
            Follow a possibility.
          </p>
        </div>
        <div className="user-menu">
          <span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span>
          <span>
            {session.user.name}
            <small>Personal workspace</small>
          </span>
          <button
            className="icon-button"
            title="Sign out"
            onClick={async () => {
              await api('/auth/sign-out', {});
              setSession(null);
            }}
          >
            ↪
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
function Welcome() {
  return (
    <div className="welcome">
      <span className="eyebrow">A BLANK SPACE IS A BEGINNING</span>
      <h1>What’s on your mind?</h1>
      <p>
        Open a brane from the sidebar, or make a new one.
        <br />
        Your thoughts don’t have to arrive in order.
      </p>
      <div className="welcome-glyph">◇</div>
    </div>
  );
}
const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Welcome });
const braneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/b/$braneId',
  validateSearch: z.object({
    focus: z.string().optional(),
    view: z.enum(['canvas', 'focus']).optional(),
  }),
  component: () => {
    const { braneId } = braneRoute.useParams(),
      search = braneRoute.useSearch();
    return <BraneView key={braneId} braneId={braneId} {...search} />;
  },
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, braneRoute]) });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
