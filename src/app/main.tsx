import { openEntry, enterGuest } from '../services/entry';
import { Dialog } from '../components/Dialog';
import React, { useEffect, useRef, useState } from 'react';
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
import { imports } from '../services/imports';
import { client } from '../services/client';
import { runEventResponse } from '../../shared/contracts';
import type { Session } from '../../shared/contracts';
import { useInteraction } from '../stores/interaction';
import { BraneView } from '../routes/BraneView';
import type { Brane } from '../../shared/types/domain';
import './styles.css';
import { AppStatus } from '../components/AppStatus';
import { PasswordRecovery } from '../components/PasswordRecovery';
import { accountPromptOf, type AccountPrompt } from '../services/account-prompt';
function AuthScreen({
  onSignedIn,
  onGuest,
  startSignup = false,
  note,
}: {
  onSignedIn: () => void;
  onGuest?: () => void;
  startSignup?: boolean;
  note?: string;
}) {
  const [guestAllowed, setGuestAllowed] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  const [signup, setSignup] = useState(startSignup),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [signupMode, setSignupMode] = useState<'open' | 'invite' | 'closed'>('closed');
  useEffect(() => {
    void client
      .entryPolicy()
      .then((policy) => setGuestAllowed(policy.guest))
      .catch(() => {});
    void client
      .recoveryPolicy()
      .then((policy) => setRecoveryEnabled(policy.enabled))
      .catch(() => setRecoveryEnabled(false));
    void client
      .signupPolicy()
      .then((policy) => {
        setSignupMode(policy.mode);
        if (policy.mode === 'closed') setSignup(false);
      })
      .catch(() => {});
  }, []);
  if (recovery) return <PasswordRecovery onBack={() => setRecovery(false)} />;
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
            const credentials = {
              email: String(form.get('email') ?? ''),
              password: String(form.get('password') ?? ''),
            };
            if (signup)
              await client.signUp({
                ...credentials,
                name: String(form.get('name') ?? ''),
                inviteCode: String(form.get('inviteCode') ?? ''),
              });
            else await client.signIn(credentials);
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
        {note && <p className="auth-note">{note}</p>}
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
        {signup && signupMode === 'invite' && (
          <label>
            Invitation code
            <input name="inviteCode" type="password" required autoComplete="off" />
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button disabled={busy} className="primary">
          {busy ? 'One moment…' : signup ? 'Create your space ↗' : 'Open your space ↗'}
        </button>
        {!signup && recoveryEnabled && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setRecovery(true)}
          >
            Forgot password?
          </button>
        )}
        {onGuest && guestAllowed && (
          <button type="button" className="text-button" disabled={busy} onClick={onGuest}>
            Continue as guest
          </button>
        )}
        {signupMode !== 'closed' && (
          <button type="button" className="text-button" onClick={() => setSignup(!signup)}>
            {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
        )}
      </form>
    </main>
  );
}
function Shell() {
  const navigation = useRef<HTMLDetailsElement>(null);
  const [authOpen, setAuthOpen] = useState<AccountPrompt | null>(null);
  const closeMobileNavigation = () => {
    if (window.matchMedia('(max-width: 760px)').matches) {
      navigation.current?.removeAttribute('open');
      navigation.current?.querySelector('summary')?.focus();
    }
  };
  const [session, setSession] = useState<Session | undefined>(undefined),
    [branes, setBranes] = useState<Brane[]>([]),
    [error, setError] = useState('');
  const navigate = useNavigate();
  const applySession = async (value: Session) => {
    if (value?.user && useInteraction.getState().actor !== value.libraryId)
      await useInteraction.getState().initialize(value.libraryId);
    await imports.activate(value?.libraryId);
    setSession(value);
    setError('');
  };
  const refreshSession = () =>
    void client
      .session()
      .then(applySession)
      .catch((e) => setError(e.message || 'Reconnect to open your workspace.'));
  const startGuest = () =>
    void enterGuest()
      .then(async (entry) => {
        await applySession(entry.session);
        await navigate({ to: '/b/$braneId', params: { braneId: entry.braneId } });
      })
      .catch((e) => setError(e.message));
  const refreshBranes = () =>
    void client
      .branes()
      .then(setBranes)
      .catch((e) => setError(e.message));
  useEffect(() => {
    const braneId = /^\/b\/([^/]+)/.exec(window.location.pathname)?.[1];
    void openEntry(braneId)
      .then(async (entry) => {
        await applySession(entry.session);
        if (entry.braneId)
          await navigate({ to: '/b/$braneId', params: { braneId: entry.braneId } });
      })
      .catch((e) => setError(e.message));
    const signIn = (event: Event) => setAuthOpen(accountPromptOf(event));
    window.addEventListener('brane:session-expired', refreshSession);
    window.addEventListener('brane:sign-in', signIn);
    return () => {
      window.removeEventListener('brane:session-expired', refreshSession);
      window.removeEventListener('brane:sign-in', signIn);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    refreshBranes();
    const events = new EventSource(`/api/events?library=${encodeURIComponent(session.libraryId)}`);
    events.addEventListener('ready', () => window.dispatchEvent(new Event('brane:reconcile')));
    events.addEventListener('run', (event) => {
      try {
        const detail = runEventResponse.parse(JSON.parse((event as MessageEvent).data));
        window.dispatchEvent(new CustomEvent('brane:run', { detail }));
      } catch {
        // SSE is only a hint. A malformed update must be reconciled from storage.
        window.dispatchEvent(new Event('brane:reconcile'));
      }
    });
    window.addEventListener('brane:reconcile', refreshBranes);
    window.addEventListener('brane:local-change', refreshBranes);
    const timer = setInterval(refreshBranes, 10000);
    return () => {
      events.close();
      window.removeEventListener('brane:reconcile', refreshBranes);
      window.removeEventListener('brane:local-change', refreshBranes);
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
  if (!session)
    return (
      <>
        <AuthScreen onSignedIn={refreshSession} onGuest={startGuest} />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <details ref={navigation} className="navigation-drawer">
        <summary role="button" aria-label="Brane navigation">
          ☰ <span>Branes</span>
        </summary>
        <aside className="sidebar">
          <Link to="/" className="wordmark">
            mem-brane
            <span className="brand-dot" />
          </Link>
          <button
            className="new-brane"
            onClick={async () => {
              try {
                const b = await client.createBrane('Untitled brane');
                refreshBranes();
                await navigate({ to: '/b/$braneId', params: { braneId: b.id } });
                closeMobileNavigation();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            ＋ New brane
          </button>
          {session.libraries.length > 1 && (
            <label className="library-picker">
              Library
              <select
                aria-label="Library"
                value={session.libraryId}
                onChange={async (event) => {
                  try {
                    await useInteraction.getState().flushRecovery();
                    await applySession(await client.session(event.target.value));
                    await navigate({ to: '/' });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {session.libraries.map((id, i) => (
                  <option key={id} value={id}>
                    {id === session.user.id ? 'Personal library' : `Saved workspace ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="section-label">
            YOUR BRANES <span>{branes.length.toString().padStart(2, '0')}</span>
          </div>
          <nav
            className="brane-nav"
            onClick={(event) => {
              if ((event.target as Element).closest('a')) closeMobileNavigation();
            }}
          >
            {branes.map((b) => (
              <Link
                to="/b/$braneId"
                params={{ braneId: b.id }}
                key={b.id}
                activeProps={{ className: 'active' }}
              >
                <span>◇</span>
                <div>{b.title}</div>
              </Link>
            ))}
          </nav>
          {error && <p className="error">{error}</p>}
          <div className="user-menu">
            <span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span>
            <span>{session.user.name}</span>
            {!session.user.isAnonymous && (
              <button
                className="icon-button"
                title="Sign out"
                onClick={async () => {
                  try {
                    await client.signOut();
                    await imports.activate(undefined);
                    setSession(null);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                ↪
              </button>
            )}
          </div>
        </aside>
      </details>
      <main className="main-content">
        <AppStatus />
        {session.user.isAnonymous && (
          <aside className="guest-notice" aria-label="Guest workspace">
            <span>
              Guest workspace · Saved on this server. Create a free account to use AI and open it on
              other devices.
              {session.guestExpiresAt && (
                <> Available until {new Date(session.guestExpiresAt).toLocaleDateString()}.</>
              )}
            </span>
            <button onClick={() => setAuthOpen({ mode: 'signup' })}>Keep your workspace</button>
            <button onClick={() => setAuthOpen({ mode: 'signin' })}>Sign in</button>
          </aside>
        )}
        <Outlet />
        {authOpen && (
          <Dialog
            title={authOpen.mode === 'signup' ? 'Keep your workspace' : 'Sign in'}
            className="account-dialog"
            onClose={() => setAuthOpen(null)}
          >
            <AuthScreen
              key={authOpen.mode}
              startSignup={authOpen.mode === 'signup'}
              note={authOpen.reason}
              onSignedIn={() => {
                setAuthOpen(null);
                refreshSession();
              }}
            />
          </Dialog>
        )}
      </main>
    </div>
  );
}
function Welcome() {
  return (
    <div className="welcome">
      <h1>What’s on your mind?</h1>
      <p>Open Branes in the upper-left corner to choose a workspace or create one.</p>
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
// Capture the token once, then remove it from browser history before mounting.
const resetPage = window.location.pathname === '/reset-password';
const resetToken = resetPage
  ? new URLSearchParams(window.location.hash.slice(1)).get('token') || undefined
  : undefined;
if (resetToken) window.history.replaceState(null, '', '/reset-password');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {resetPage ? (
      <PasswordRecovery token={resetToken} onBack={() => window.location.replace('/')} />
    ) : (
      <RouterProvider router={router} />
    )}
  </React.StrictMode>,
);
