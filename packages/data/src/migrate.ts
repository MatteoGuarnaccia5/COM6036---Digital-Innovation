/**
 * Migration runner.
 *
 * Both `web` and `scheduler` call this on start. Neither waits for the other,
 * and neither is ordered ahead of the other in Docker Compose - that is what
 * makes their lifecycles genuinely independent. A Postgres advisory lock makes
 * the resulting race safe: whichever process arrives first applies the
 * migrations while the other blocks, then finds nothing left to do.
 */
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** Arbitrary but fixed. Any process migrating this database uses this key. */
const MIGRATION_LOCK_KEY = 4_820_017;

/**
 * `src/migrate.ts` and `dist/migrate.js` are both one level below the package
 * root, so this resolves to `packages/data/migrations` either way.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
