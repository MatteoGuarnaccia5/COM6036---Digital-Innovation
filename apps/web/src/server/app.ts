/**
 * The Express application, as a function of its dependencies.
 *
 * Nothing is constructed here that a test would want to replace: no pool, no
 * service, no clock. They arrive as arguments, which is what lets the
 * integration suite drive the real application with Supertest and no listening
 * socket, and lets `index.ts` remain a short composition root.
 */
import path from 'node:path';

import type { AuthService, TaskService } from '@tasks/core';
import type { ConnectionPool } from '@tasks/data';
import connectPgSimple from 'connect-pg-simple';
import express, { type Express } from 'express';
import session from 'express-session';

import { errorHandler, notFoundHandler } from './presentation/errors.js';
import { requireAuthentication } from './presentation/session.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createTaskRouter } from './routes/task-routes.js';

export const SESSION_COOKIE_NAME = 'tasks.sid';
/** Seven days. Long enough to be convenient, short enough to bound exposure. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppDependencies {
  /** Owned by the data layer; used here only by the session store. */
  readonly pool: ConnectionPool;
  readonly authService: AuthService;
  readonly taskService: TaskService;
  /** Signs the session cookie. Must not be the development default in production. */
  readonly sessionSecret: string;
  /** Sets the `Secure` cookie flag. False over plain HTTP, or no cookie is sent. */
  readonly secureCookies: boolean;
  /**
   * Absolute path to the built React client, or null to serve the API alone -
   * which is what the integration suite and the Vite dev server both want.
   */
  readonly clientDistPath?: string | null | undefined;
  /**
   * How often the session store deletes expired rows, in seconds; `false`
   * disables it.
   *
   * Exposed because the store's timer outlives the application object. In tests
   * that build several apps over one pool, those timers would keep firing
   * queries after the pool had been closed, which surfaces as a failure in
   * whichever unrelated test happens to be running at the time.
   */
  readonly sessionPruneIntervalSeconds?: number | false | undefined;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  /* Behind a reverse proxy this is what lets express-session see the original
     protocol and decide correctly about a Secure cookie. */
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '64kb' }));

  const PostgresSessionStore = connectPgSimple(session);

  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: dependencies.sessionSecret,
      store: new PostgresSessionStore({
        pool: dependencies.pool,
        tableName: 'session',
        /* The table is a checked-in migration, applied at start-up under an
           advisory lock, so the store must not try to create it itself. */
        createTableIfMissing: false,
        pruneSessionInterval: dependencies.sessionPruneIntervalSeconds ?? 60,
      }),
      /* Only write a session row once there is something to remember, and only
         rewrite it when it changes. */
      resave: false,
      saveUninitialized: false,
      /* Refresh the expiry on activity, so an active user is not signed out
         mid-session. */
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: dependencies.secureCookies,
        maxAge: SESSION_MAX_AGE_MS,
        path: '/',
      },
    }),
  );

  app.get('/api/v1/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use('/api/v1/auth', createAuthRouter(dependencies.authService));

  /* Every task route sits behind authentication, applied once at the mount
     point rather than repeated per handler - a route added later cannot forget
     it. */
  app.use(
    '/api/v1/tasks',
    requireAuthentication(dependencies.authService),
    createTaskRouter(dependencies.taskService),
  );

  /*
   * The built client, served by the same Express app that owns the API.
   *
   * Same-origin is the whole point: the session cookie is sent with every
   * request without CORS, without `credentials: 'include'`, and without
   * relaxing SameSite. Anything not under /api/ falls through to index.html so
   * that a refresh on any path still loads the application.
   */
  const clientDistPath = dependencies.clientDistPath ?? null;
  if (clientDistPath !== null) {
    app.use(express.static(clientDistPath, { index: false }));

    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/')) {
        next();
        return;
      }
      response.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
