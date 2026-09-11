/**
 * Runs the repository contract twice: once in memory, once against Postgres.
 * See repository-contract.ts for why.
 */
import { createRepositories } from '@tasks/data';
import { afterAll, beforeAll } from 'vitest';

import { createInMemoryBackend } from '../support/fakes/in-memory-repositories.js';
import { setupTestDatabase, type TestDatabase } from '../support/database.js';
import { describeRepositoryContract } from './repository-contract.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await setupTestDatabase();
});

afterAll(async () => {
  await database.close();
});

describeRepositoryContract('in-memory fakes', async () => createInMemoryBackend().repositories);

describeRepositoryContract('Drizzle on Postgres', async () => {
  await database.reset();
  return createRepositories(database.db);
});
