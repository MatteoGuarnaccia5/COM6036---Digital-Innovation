/**
 * The web process's composition root.
 *
 * This is the only file in the application that knows about every layer at
 * once. It builds the concrete adapters - a Postgres pool, bcrypt, the system
 * clock - injects them into the business logic, hands the result to Express,
 * and starts listening. Nothing else needs to know how any of it was assembled.
 *
 * Migrations run here, on start, guarded by an advisory lock. The scheduler
 * does exactly the same thing independently: neither process waits for the
 * other, and neither is ordered ahead of the other in Docker Compose.
 */
import { createAuthService, createTaskService } from '@tasks/core';
import {
  createDatabase,
  createPool,
  createUnitOfWork,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  runMigrations,
  seedDemoData,
} from '@tasks/data';

import { createBcryptPasswordHasher } from './adapters/bcrypt-password-hasher.js';
import { systemClock } from './adapters/system-clock.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);

  console.log('[web] applying migrations');
  await runMigrations(pool);

  const database = createDatabase(pool);
  const unitOfWork = createUnitOfWork(database);
  const passwordHasher = createBcryptPasswordHasher();

  const authService = createAuthService({ unitOfWork, passwordHasher });
  const taskService = createTaskService({ unitOfWork, clock: systemClock });

  if (config.seedOnStart) {
    const result = await seedDemoData(database, {
      passwordHash: await passwordHasher.hash(DEMO_PASSWORD),
    });
    console.log(
      result.seeded
        ? `[web] seeded demo data: ${DEMO_EMAIL} / ${DEMO_PASSWORD}, ${String(result.taskCount)} tasks`
        : '[web] database already populated, skipping seed',
    );
  }

  const app = createApp({
    pool,
    authService,
    taskService,
    sessionSecret: config.sessionSecret,
    secureCookies: config.secureCookies,
    clientDistPath: config.clientDistPath,
  });

  if (config.clientDistPath === null) {
    console.warn('[web] no built client found; serving the API only');
  }

  const server = app.listen(config.port, () => {
    console.log(`[web] listening on http://0.0.0.0:${String(config.port)}`);
  });

  /* Finish in-flight requests, then let go of the pool, so a restart does not
     leave connections open or truncate a response. */
  const shutdown = (signal: string): void => {
    console.log(`[web] ${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => {
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  console.error('[web] failed to start', error);
  process.exit(1);
});
