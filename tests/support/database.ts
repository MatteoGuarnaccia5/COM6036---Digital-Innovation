/**
 * Throwaway Postgres for the integration and scheduler suites.
 *
 * The unit suites in `tests/unit` never touch this: business logic is tested
 * against in-memory fakes, with no database and no HTTP. Only the suites that
 * exist to prove the data access layer and the scheduler's locking behaviour
 * connect to a real server, because `FOR UPDATE SKIP LOCKED` cannot be
 * meaningfully faked.
 *
 * `vitest.config.ts` sets `fileParallelism: false`, so one database is shared
 * across files and reset between tests.
 */
import { createDatabase, createPool, runMigrations, type Database } from '@tasks/data';
import type pg from 'pg';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://tasks:tasks@localhost:5432/tasks_test';

export interface TestDatabase {
  readonly pool: pg.Pool;
  readonly db: Database;
  /** Empties every table. Call in `beforeEach`. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function setupTestDatabase(): Promise<TestDatabase> {
  const pool = createPool(TEST_DATABASE_URL);
  await runMigrations(pool);
  const db = createDatabase(pool);

  return {
    pool,
    db,
    async reset(): Promise<void> {
      await pool.query('TRUNCATE TABLE reminders, tasks, users, "session" RESTART IDENTITY CASCADE');
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
