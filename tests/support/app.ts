/**
 * Builds the real Express application over a real database for the integration
 * suite.
 *
 * Nothing is stubbed: genuine bcrypt, genuine Postgres-backed sessions, genuine
 * repositories. Supertest drives the app object directly, so no port is bound
 * and the tests stay fast without becoming unrepresentative.
 */
import { createAuthService, createTaskService, type AuthService, type TaskService } from '@tasks/core';
import { createUnitOfWork } from '@tasks/data';
import { createApp } from '@tasks/web';
import { createBcryptPasswordHasher } from '@tasks/web/adapters/bcrypt-password-hasher';
import type { Express } from 'express';

import { setupTestDatabase, type TestDatabase } from './database.js';

/**
 * bcrypt's cost factor is 10 in production, which is roughly 70ms per hash and
 * correct there. The integration suite hashes on nearly every test, so it runs
 * at the library's minimum. What is being tested here is the wiring - that a
 * password is hashed, stored and verified through the real adapter - not the
 * cost factor, which is asserted separately.
 */
const TEST_COST_FACTOR = 4;

export interface TestApp {
  readonly app: Express;
  readonly database: TestDatabase;
  readonly authService: AuthService;
  readonly taskService: TaskService;
  /** Rebuilds the app over the same database, as a container restart would. */
  restart(): Express;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export const TEST_SESSION_SECRET = 'test-session-secret';

export async function setupTestApp(): Promise<TestApp> {
  const database = await setupTestDatabase();

  const unitOfWork = createUnitOfWork(database.db);
  const passwordHasher = createBcryptPasswordHasher(TEST_COST_FACTOR);
  const authService = createAuthService({ unitOfWork, passwordHasher });
  const taskService = createTaskService({
    unitOfWork,
    clock: { now: (): Date => new Date() },
  });

  const build = (): Express =>
    createApp({
      pool: database.pool,
      authService,
      taskService,
      sessionSecret: TEST_SESSION_SECRET,
      secureCookies: false,
      /* No background timers: `restart()` builds a second app over the same
         pool, and a prune timer from a discarded one would go on issuing
         queries after `close()` had ended the pool. */
      sessionPruneIntervalSeconds: false,
    });

  return {
    app: build(),
    database,
    authService,
    taskService,
    restart: build,
    reset: () => database.reset(),
    close: () => database.close(),
  };
}
