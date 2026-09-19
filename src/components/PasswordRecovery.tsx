import React, { useState } from 'react';
import { client } from '../services/client';

export function PasswordRecovery({ token, onBack }: { token?: string; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  return (
    <main className="auth-screen">
      <form
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError('');
          try {
            if (token) {
              const password = String(form.get('password') ?? '');
              if (password !== form.get('confirm')) throw new Error('Passwords must match.');
              await client.resetPassword(token, password);
            } else await client.requestPasswordReset(String(form.get('email') ?? ''));
            setDone(true);
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{token ? 'Choose a new password' : 'Reset your password'}</h1>
        {done ? (
          <p role="status">
            {token
              ? 'Your password has changed. Sign in again on each device.'
              : 'If an account exists for that email, a reset link will arrive shortly. Check your spam folder too.'}
          </p>
        ) : (
          <>
            {token ? (
              <>
                <label>
                  New password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    name="confirm"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <p>The link expires after 15 minutes and works once.</p>
              </>
            ) : (
              <label>
                Email
                <input name="email" type="email" autoComplete="email" required />
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? 'One moment…' : token ? 'Change password' : 'Send reset link'}
            </button>
          </>
        )}
        <button className="text-button" type="button" disabled={busy} onClick={onBack}>
          Back to sign in
        </button>
      </form>
    </main>
  );
}
