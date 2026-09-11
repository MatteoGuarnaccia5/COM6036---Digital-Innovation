/**
 * Cross-user isolation, against a real database.
 *
 * The unit suite already proves the service refuses another user's task, but it
 * proves it against fakes that were written to behave that way. This exercises
 * the actual SQL: the `WHERE user_id = $2` on every task query is what makes
 * the guarantee real, and a repository refactor that dropped it would pass the
 * unit tests and fail here.
 *
 * The isolation is expressed as *not found*, never as *forbidden*. A 403 would
 * confirm that a task with that id exists and belongs to somebody, which is
 * exactly the fact the API should not disclose. The same test therefore checks
 * that an id belonging to another user is indistinguishable from an id that was
 * never issued.
 */
import { TaskNotFoundError, createTaskService, type TaskService } from '@tasks/core';
import { createRepositories, createUnitOfWork } from '@tasks/data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupTestDatabase, type TestDatabase } from '../support/database.js';

const NEVER_ISSUED_ID = '00000000-0000-0000-0000-000000000000';

let database: TestDatabase;
let taskService: TaskService;
let ownerId: string;
let intruderId: string;
let taskId: string;

beforeAll(async () => {
  database = await setupTestDatabase();
  taskService = createTaskService({
    unitOfWork: createUnitOfWork(database.db),
    clock: { now: (): Date => new Date() },
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();

  const repositories = createRepositories(database.db);
  const owner = await repositories.users.create({
    email: 'owner@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  const intruder = await repositories.users.create({
    email: 'intruder@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  ownerId = owner.id;
  intruderId = intruder.id;

  const task = await taskService.create({
    userId: ownerId,
    title: 'Confidential: salary review',
    description: 'Nobody else should know this exists.',
    dueAt: new Date('2026-06-01T09:00:00.000Z'),
    priority: 'high',
    recurrence: null,
  });
  taskId = task.id;
});

describe('a task belonging to another user', () => {
  it('cannot be read', async () => {
    await expect(taskService.get(intruderId, taskId)).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('cannot be updated, and is left untouched', async () => {
    await expect(
      taskService.update(intruderId, taskId, { title: 'hijacked', priority: 'low' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    const stillThere = await taskService.get(ownerId, taskId);
    expect(stillThere.title).toBe('Confidential: salary review');
    expect(stillThere.priority).toBe('high');
  });

  it('cannot be completed', async () => {
    await expect(taskService.complete(intruderId, taskId)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );

    const stillOpen = await taskService.get(ownerId, taskId);
    expect(stillOpen.status).toBe('open');
  });

  it('cannot be deleted, and its reminder survives', async () => {
    await expect(taskService.remove(intruderId, taskId)).rejects.toBeInstanceOf(TaskNotFoundError);

    await expect(taskService.get(ownerId, taskId)).resolves.toBeDefined();

    const { rows } = await testCount();
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('does not appear in the other user’s list', async () => {
    await expect(taskService.list(intruderId)).resolves.toEqual([]);
    await expect(taskService.list(ownerId)).resolves.toHaveLength(1);
  });

  it('is reported exactly as an id that was never issued', async () => {
    const otherUsersTask = await taskService
      .get(intruderId, taskId)
      .catch((error: unknown) => error);
    const nonexistent = await taskService
      .get(intruderId, NEVER_ISSUED_ID)
      .catch((error: unknown) => error);

    expect(otherUsersTask).toBeInstanceOf(TaskNotFoundError);
    expect(nonexistent).toBeInstanceOf(TaskNotFoundError);
    /* Same class, same message: nothing distinguishes "someone else's" from
       "no such thing". */
    expect((otherUsersTask as Error).message).toBe((nonexistent as Error).message);
  });
});

async function testCount(): Promise<{ rows: { count: string }[] }> {
  return database.pool.query<{ count: string }>(
    'SELECT count(*) FROM reminders WHERE task_id = $1',
    [taskId],
  );
}
