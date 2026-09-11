/**
 * The application shell.
 *
 * There is no router. The application has exactly two states and they are
 * determined by whether there is a session, not by a URL: signed out shows the
 * sign-in screen, signed in shows the task list. Creating and editing happen
 * inline on the list, because a task must be creatable in at most two clicks
 * from it - a separate route would make that impossible by construction.
 * Adding a router to express two states that no one can navigate between would
 * be ceremony, not structure.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';

import type { UserDto } from '../shared/api-types';
import { api } from './api';
import { AuthPage } from './components/AuthPage';
import { TaskListPage } from './components/TaskListPage';

type Session =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'signed-in'; readonly user: UserDto };

export function App(): JSX.Element {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void api
      .currentUser()
      .then((user) => {
        if (cancelled) return;
        setSession(user === null ? { status: 'anonymous' } : { status: 'signed-in', user });
      })
      .catch(() => {
        if (!cancelled) setSession({ status: 'anonymous' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignedIn = useCallback((user: UserDto) => {
    setSession({ status: 'signed-in', user });
  }, []);

  const handleSignedOut = useCallback(() => {
    setSession({ status: 'anonymous' });
  }, []);

  if (session.status === 'loading') {
    /* Announced politely so a screen reader is told the wait is deliberate. */
    return (
      <main className="page">
        <p role="status">Loading…</p>
      </main>
    );
  }

  if (session.status === 'anonymous') {
    return <AuthPage onSignedIn={handleSignedIn} />;
  }

  return <TaskListPage user={session.user} onSignedOut={handleSignedOut} />;
}
