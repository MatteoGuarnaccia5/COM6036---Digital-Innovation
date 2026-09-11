/**
 * Unit tests for FR2 and FR3 - task operations and state transitions.
 *
 * These run entirely against in-memory fakes: no database, no HTTP server, no
 * real clock. That is possible because the business logic layer depends only on
 * interfaces, and it is sound because tests/contract holds those fakes to the
 * same contract as the Drizzle implementations.
 */
import {
  TaskNotFoundError,
  ValidationError,
  createTaskService,
  type CreateTaskInput,
  type TaskService,
} from '@tasks/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock, type FakeClock } from '../support/fakes/fake-clock.js';
import {
  createInMemoryBackend,
  type InMemoryBackend,
} from '../support/fakes/in-memory-repositories.js';

const NOW = new Date('2026-05-04T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

let clock: FakeClock;
let backend: InMemoryBackend;
let service: TaskService;
let ownerId: string;
let strangerId: string;

const taskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  userId: ownerId,
  title: 'Write the report',
  description: null,
  dueAt: new Date('2026-05-06T17:00:00.000Z'),
  priority: 'medium',
  recurrence: null,
  ...overrides,
});

beforeEach(async () => {
  clock = createFakeClock(NOW);
  backend = createInMemoryBackend(clock);
  service = createTaskService({ unitOfWork: backend.unitOfWork, clock });

  const owner = await backend.repositories.users.create({
    email: 'owner@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  const stranger = await backend.repositories.users.create({
    email: 'stranger@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  ownerId = owner.id;
  strangerId = stranger.id;
});

describe('creating a task', () => {
  it('creates it open, with a reminder scheduled before the deadline', async () => {
    const task = await service.create(taskInput({ reminderOffsetMinutes: 120 }));

    expect(task).toMatchObject({ status: 'open', completedAt: null, parentTaskId: null });

    const reminder = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(reminder?.fireAt.toISOString()).toBe('2026-05-06T15:00:00.000Z');
  });

  it('defaults the reminder offset to an hour', async () => {
    const task = await service.create(taskInput());

    const reminder = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(task.reminderOffsetMinutes).toBe(60);
    expect(reminder?.fireAt.toISOString()).toBe('2026-05-06T16:00:00.000Z');
  });

  it('schedules no reminder for a task with no deadline', async () => {
    const task = await service.create(taskInput({ dueAt: null }));

    await expect(backend.repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
  });

  it('trims the title and treats a blank description as absent', async () => {
    const task = await service.create(taskInput({ title: '  Tidy up  ', description: '   ' }));

    expect(task.title).toBe('Tidy up');
    expect(task.description).toBeNull();
  });

  it('rejects a blank title', async () => {
    await expect(service.create(taskInput({ title: '   ' }))).rejects.toThrow(ValidationError);
  });

  it('rejects a recurring task with no deadline to advance', async () => {
    await expect(
      service.create(taskInput({ recurrence: 'weekly', dueAt: null })),
    ).rejects.toThrow(/recurring task needs a due date/i);
  });

  it('writes a reminder whose firing time has already passed', async () => {
    /* It will simply go out on the next tick - the same path that recovers
       reminders missed during downtime. */
    const task = await service.create(
      taskInput({ dueAt: new Date(NOW.getTime() - 5 * HOUR_MS) }),
    );

    const reminder = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(reminder).not.toBeNull();
    expect(reminder!.fireAt.getTime()).toBeLessThan(NOW.getTime());
  });
});

describe('updating a task', () => {
  it('moves the pending reminder when the deadline moves', async () => {
    const task = await service.create(taskInput());
    const before = await backend.repositories.reminders.findPendingForTask(task.id);

    await service.update(ownerId, task.id, { dueAt: new Date('2026-05-09T17:00:00.000Z') });

    const after = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(after?.id).toBe(before?.id);
    expect(after?.fireAt.toISOString()).toBe('2026-05-09T16:00:00.000Z');
  });

  it('moves the pending reminder when only the offset changes', async () => {
    const task = await service.create(taskInput());

    await service.update(ownerId, task.id, { reminderOffsetMinutes: 30 });

    const reminder = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(reminder?.fireAt.toISOString()).toBe('2026-05-06T16:30:00.000Z');
  });

  it('removes the reminder when the deadline is cleared', async () => {
    const task = await service.create(taskInput());

    await service.update(ownerId, task.id, { dueAt: null });

    await expect(backend.repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
  });

  it('leaves fields that were not mentioned alone', async () => {
    const task = await service.create(taskInput({ description: 'original', priority: 'high' }));

    const updated = await service.update(ownerId, task.id, { title: 'renamed' });

    expect(updated).toMatchObject({
      title: 'renamed',
      description: 'original',
      priority: 'high',
    });
  });

  it('validates the task as it will be, not just the fields being changed', async () => {
    const task = await service.create(taskInput({ recurrence: 'weekly' }));

    await expect(service.update(ownerId, task.id, { dueAt: null })).rejects.toThrow(
      /recurring task needs a due date/i,
    );
  });
});

describe('completing a task', () => {
  it('marks it done at the current instant and drops its reminder', async () => {
    const task = await service.create(taskInput());
    clock.advance(3 * HOUR_MS);

    const result = await service.complete(ownerId, task.id);

    expect(result.task.status).toBe('done');
    expect(result.task.completedAt?.toISOString()).toBe('2026-05-04T13:00:00.000Z');
    expect(result.nextOccurrence).toBeNull();
    await expect(backend.repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
  });

  it('generates the next occurrence of a recurring task, with its own reminder', async () => {
    const task = await service.create(
      taskInput({ recurrence: 'weekly', dueAt: new Date('2026-05-06T17:00:00.000Z') }),
    );

    const result = await service.complete(ownerId, task.id);
    const occurrence = result.nextOccurrence;

    expect(occurrence).not.toBeNull();
    expect(occurrence).toMatchObject({
      title: task.title,
      priority: task.priority,
      recurrence: 'weekly',
      status: 'open',
      parentTaskId: task.id,
    });
    expect(occurrence?.dueAt?.toISOString()).toBe('2026-05-13T17:00:00.000Z');

    const reminder = await backend.repositories.reminders.findPendingForTask(occurrence!.id);
    expect(reminder?.fireAt.toISOString()).toBe('2026-05-13T16:00:00.000Z');
  });

  it('anchors every occurrence to the root task rather than nesting', async () => {
    const root = await service.create(taskInput({ recurrence: 'daily' }));

    const second = (await service.complete(ownerId, root.id)).nextOccurrence;
    const third = (await service.complete(ownerId, second!.id)).nextOccurrence;

    expect(second?.parentTaskId).toBe(root.id);
    expect(third?.parentTaskId).toBe(root.id);
    expect(third?.dueAt?.toISOString()).toBe('2026-05-08T17:00:00.000Z');
  });

  it('is idempotent: completing twice does not generate a second occurrence', async () => {
    const task = await service.create(taskInput({ recurrence: 'daily' }));

    const first = await service.complete(ownerId, task.id);
    const second = await service.complete(ownerId, task.id);

    expect(first.nextOccurrence).not.toBeNull();
    expect(second.nextOccurrence).toBeNull();
    expect(backend.store.tasks.size).toBe(2);
  });

  it('carries the reminder offset onto the generated occurrence', async () => {
    const task = await service.create(taskInput({ recurrence: 'daily', reminderOffsetMinutes: 15 }));

    const occurrence = (await service.complete(ownerId, task.id)).nextOccurrence;

    expect(occurrence?.reminderOffsetMinutes).toBe(15);
  });
});

describe('deleting a task', () => {
  it('removes the task and its unsent reminder', async () => {
    const task = await service.create(taskInput());

    await service.remove(ownerId, task.id);

    expect(backend.store.tasks.size).toBe(0);
    expect(backend.store.reminders.size).toBe(0);
  });
});

describe('isolation between users', () => {
  it('reports another user’s task as not found, and leaves it untouched', async () => {
    const task = await service.create(taskInput());

    await expect(service.get(strangerId, task.id)).rejects.toThrow(TaskNotFoundError);
    await expect(service.update(strangerId, task.id, { title: 'hijacked' })).rejects.toThrow(
      TaskNotFoundError,
    );
    await expect(service.complete(strangerId, task.id)).rejects.toThrow(TaskNotFoundError);
    await expect(service.remove(strangerId, task.id)).rejects.toThrow(TaskNotFoundError);

    const untouched = await service.get(ownerId, task.id);
    expect(untouched).toMatchObject({ title: 'Write the report', status: 'open' });
    expect(backend.store.reminders.size).toBe(1);
  });

  it('lists only the requesting user’s tasks', async () => {
    await service.create(taskInput({ title: 'mine' }));
    await service.create(taskInput({ userId: strangerId, title: 'theirs' }));

    const listed = await service.list(ownerId);
    expect(listed.map((task) => task.title)).toEqual(['mine']);
  });
});
