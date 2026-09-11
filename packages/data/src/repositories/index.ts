/**
 * The composition helpers every process uses to obtain repositories.
 *
 * `createRepositories(db)` gives non-transactional handles for ordinary reads
 * and single writes. `createUnitOfWork(db)` gives business logic a way to run
 * several operations atomically without ever naming a transaction: it opens
 * one, binds a fresh set of repositories to it, and rolls back if the work
 * throws.
 */
import type { Repositories, UnitOfWork } from '@tasks/core';

import type { Database, DatabaseExecutor } from '../client.js';
import { createReminderRepository } from './reminder-repository.js';
import { createTaskRepository } from './task-repository.js';
import { createUserRepository } from './user-repository.js';

export function createRepositories(executor: DatabaseExecutor): Repositories {
  return {
    users: createUserRepository(executor),
    tasks: createTaskRepository(executor),
    reminders: createReminderRepository(executor),
  };
}

export function createUnitOfWork(db: Database): UnitOfWork {
  return {
    run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
      return db.transaction((tx) => work(createRepositories(tx)));
    },
  };
}

export { createReminderRepository } from './reminder-repository.js';
export { createTaskRepository } from './task-repository.js';
export { createUserRepository } from './user-repository.js';
