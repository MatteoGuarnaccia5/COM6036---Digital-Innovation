/**
 * Connection plumbing. The only place in the repository that constructs a
 * database pool; every process obtains one from here.
 */
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Re-exported so that the presentation layer can hold a pool for the session
 * store without importing `pg` itself. Database plumbing enters the application
 * through this layer or not at all - the lint rules enforce it.
 */
export type ConnectionPool = pg.Pool;

/**
 * A database handle inside a transaction. Repository methods accept this so
 * that business logic can compose several writes atomically without knowing
 * that transactions - or SQL - exist.
 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either a pooled connection or an open transaction - the common supertype of
 * both. Every repository is constructed from one of these, so the same
 * implementation serves a one-off read and a step inside a unit of work.
 */
export type DatabaseExecutor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    // Keep timestamps unambiguous regardless of the host's zone. Everything
    // below the presentation layer is UTC.
    options: '-c timezone=UTC',
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

export { schema };
