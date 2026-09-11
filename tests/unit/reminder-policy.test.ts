/**
 * Unit tests for the reminder scheduling policy in isolation - the rule that
 * decides when a reminder should fire, and the reconciliation that keeps the
 * stored reminder in step with its task.
 */
import { computeReminderFireTime, synchroniseReminder, type Task } from '@tasks/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../support/fakes/fake-clock.js';
import {
  createInMemoryBackend,
  type InMemoryBackend,
} from '../support/fakes/in-memory-repositories.js';

const NOW = new Date('2026-05-04T10:00:00.000Z');
const DEADLINE = new Date('2026-05-06T17:00:00.000Z');

let backend: InMemoryBackend;
let userId: string;

const givenTask = async (overrides: Partial<Task> = {}): Promise<Task> => {
  const created = await backend.repositories.tasks.create({
    userId,
    title: 'Submit the report',
    description: null,
    dueAt: DEADLINE,
    priority: 'medium',
    recurrence: null,
    parentTaskId: null,
    reminderOffsetMinutes: 60,
  });
  return { ...created, ...overrides };
};

beforeEach(async () => {
  backend = createInMemoryBackend(createFakeClock(NOW));
  const user = await backend.repositories.users.create({
    email: 'demo@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  userId = user.id;
});

describe('computeReminderFireTime', () => {
  it('subtracts the offset from the deadline', () => {
    expect(computeReminderFireTime(DEADLINE, 60).toISOString()).toBe('2026-05-06T16:00:00.000Z');
    expect(computeReminderFireTime(DEADLINE, 1440).toISOString()).toBe('2026-05-05T17:00:00.000Z');
  });

  it('fires at the deadline itself when the offset is zero', () => {
    expect(computeReminderFireTime(DEADLINE, 0).toISOString()).toBe(DEADLINE.toISOString());
  });

  it('is unaffected by the host timezone, being plain instant arithmetic', () => {
    const original = process.env['TZ'];
    try {
      process.env['TZ'] = 'Asia/Kolkata';
      const kolkata = computeReminderFireTime(DEADLINE, 90).toISOString();
      process.env['TZ'] = 'America/Chicago';
      const chicago = computeReminderFireTime(DEADLINE, 90).toISOString();
      expect(kolkata).toBe(chicago);
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});

describe('synchroniseReminder', () => {
  it('creates exactly one reminder for an open task with a deadline', async () => {
    const task = await givenTask();

    await synchroniseReminder(backend.repositories, task);
    await synchroniseReminder(backend.repositories, task);

    expect(backend.store.reminders.size).toBe(1);
  });

  it('creates none for a task with no deadline', async () => {
    const task = await givenTask({ dueAt: null });

    await synchroniseReminder(backend.repositories, task);

    expect(backend.store.reminders.size).toBe(0);
  });

  it('moves the existing reminder rather than adding another', async () => {
    const task = await givenTask();
    await synchroniseReminder(backend.repositories, task);
    const original = await backend.repositories.reminders.findPendingForTask(task.id);

    const moved: Task = { ...task, dueAt: new Date('2026-05-08T09:00:00.000Z') };
    await synchroniseReminder(backend.repositories, moved);

    const updated = await backend.repositories.reminders.findPendingForTask(task.id);
    expect(backend.store.reminders.size).toBe(1);
    expect(updated?.id).toBe(original?.id);
    expect(updated?.fireAt.toISOString()).toBe('2026-05-08T08:00:00.000Z');
  });

  it('removes the reminder once the task is done', async () => {
    const task = await givenTask();
    await synchroniseReminder(backend.repositories, task);

    await synchroniseReminder(backend.repositories, {
      ...task,
      status: 'done',
      completedAt: NOW,
    });

    expect(backend.store.reminders.size).toBe(0);
  });

  it('never disturbs a reminder that has already been delivered', async () => {
    const task = await givenTask();
    const delivered = await backend.repositories.reminders.create({
      taskId: task.id,
      fireAt: new Date('2026-05-01T09:00:00.000Z'),
    });
    await backend.repositories.reminders.markSent(delivered.id, new Date('2026-05-01T09:00:05.000Z'));

    await synchroniseReminder(backend.repositories, task);

    /* The delivered row survives as history; a new pending one is added. */
    expect(backend.store.reminders.get(delivered.id)?.sentAt).not.toBeNull();
    expect(backend.store.reminders.get(delivered.id)?.fireAt.toISOString()).toBe(
      '2026-05-01T09:00:00.000Z',
    );
    expect(backend.store.reminders.size).toBe(2);
  });
});
