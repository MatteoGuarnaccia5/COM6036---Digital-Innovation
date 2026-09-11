/**
 * FR1 - the sign-in and registration screen.
 *
 * One form in two modes rather than two screens, because the fields are almost
 * identical and switching should not cost a navigation. The heading changes
 * with the mode, the submit button says what it will do, and errors are
 * announced.
 */
import { useId, useState, type FormEvent, type JSX } from 'react';

import type { UserDto } from '../../shared/api-types';
import { ApiError, api } from '../api';

interface AuthPageProps {
  readonly onSignedIn: (user: UserDto) => void;
}

/** The browser's own guess, so a new account starts in the right zone. */
function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  } catch {
    return 'Europe/London';
  }
}

export function AuthPage({ onSignedIn }: AuthPageProps): JSX.Element {
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const registering = mode === 'register';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const user = registering
        ? await api.register(email, password, detectTimeZone())
        : await api.logIn(email, password);
      onSignedIn(user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <main className="page page--narrow">
      <h1>Tasks</h1>

      <section className="card" aria-labelledby="auth-heading">
        <h2 id="auth-heading">{registering ? 'Create an account' : 'Sign in'}</h2>

        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          noValidate
        >
          {error !== null && (
            <p className="alert" role="alert" id={errorId}>
              {error}
            </p>
          )}

          <div className="field">
            <label htmlFor={emailId}>Email address</label>
            <input
              id={emailId}
              type="email"
              name="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              autoComplete="username"
              required
              aria-describedby={error === null ? undefined : errorId}
            />
          </div>

          <div className="field">
            <label htmlFor={passwordId}>Password</label>
            <input
              id={passwordId}
              type="password"
              name="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete={registering ? 'new-password' : 'current-password'}
              required
              minLength={registering ? 8 : undefined}
              aria-describedby={registering ? 'password-hint' : undefined}
            />
            {registering && (
              <p className="hint" id="password-hint">
                At least 8 characters.
              </p>
            )}
          </div>

          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="switch-mode">
          {registering ? 'Already have an account?' : 'No account yet?'}{' '}
          <button
            type="button"
            className="button button--link"
            onClick={() => {
              setMode(registering ? 'sign-in' : 'register');
              setError(null);
            }}
          >
            {registering ? 'Sign in instead' : 'Create one'}
          </button>
        </p>
      </section>
    </main>
  );
}
