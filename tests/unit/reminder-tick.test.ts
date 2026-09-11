/**
 * Unit tests for the reminder tick - the delivery rules, with no database and
 * no mail server.
 *
 * The two properties the specification calls out, exactly-once delivery and
 * recovery after downtime, are asserted here at the level of the rules and
 * again in tests/scheduler against a real Postgres server, where row locking
 * and transactions genuinely apply. Both levels are worth having: this one
 * pins the logic, that one pins the mechanism.
 */
import {
  MAX_DELIVERY_ATTEMPTS,
  runReminderTick,
  type Reminder,
  type Task,
} from '@tasks/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock, type FakeClock } from '../support/fakes/fake-clock.js';
import {
  createInMemoryBackend,
  type InMemoryBackend,
} from '../support/fakes/in-memory-repositories.js';
import {
  createRecordingNotifier,
  type RecordingNotifier,
} from '../support/fakes/recording-notifier.js';

const NOW = new Date('2026-05-04T10:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

let clock: FakeClock;
let backend: InMemoryBackend;
let notifier: RecordingNotifier;
let userId: string;

const tick = async (): Promise<{ claimed: number; delivered: number; failed: number }> =>
  runReminderTick({ unitOfWork: backend.unitOfWork, notifier, clock });

async function givenTaskWithReminder(options: {
  title?: string;
  /** Firing time relative to NOW, in milliseconds. Negative means already due. */
  fireOffsetMs: number;
}): Promise<{ task: Task; reminder: Reminder }> {
  const task = await backend.repositories.tasks.create({
    userId,
    title: options.title ?? 'Submit the report',
    description: null,
    dueAt: new Date(NOW.getTime() + 2 * HOUR_MS),
    priority: 'high',
    recurrence: null,
    parentTaskId: null,
    reminderOffsetMinutes: 60,
  });

  const reminder = await backend.repositories.reminders.create({
    taskId: task.id,
    fireAt: new Date(NOW.getTime() + options.fireOffsetMs),
  });

  return { task, reminder };
}

beforeEach(async () => {
  clock = createFakeClock(NOW);
  backend = createInMemoryBackend(clock);
  notifier = createRecordingNotifier();

  const user = await backend.repositories.users.create({
    email: 'demo@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  userId = user.id;
});

describe('delivering due reminders', () => {
  it('delivers a reminder that is due and stamps it as sent', async () => {
    const { reminder } = await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(notifier.delivered).toHaveLength(1);
    expect(backend.store.reminders.get(reminder.id)?.sentAt).toEqual(NOW);
  });

  it('leaves a reminder that is not yet due alone', async () => {
    await givenTaskWithReminder({ fireOffsetMs: 30 * MINUTE_MS });

    const result = await tick();

    expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(notifier.delivered).toEqual([]);
  });

  it('hands the notifier everything it needs to write the email', async () => {
    await givenTaskWithReminder({ title: 'Pay rent', fireOffsetMs: -MINUTE_MS });

    await tick();

    expect(notifier.delivered[0]).toMatchObject({
      task: { title: 'Pay rent', priority: 'high' },
      recipient: { email: 'demo@example.com', timezone: 'Europe/London' },
    });
    /* The recipient's timezone travels with the reminder precisely because the
       business logic will not format a local time itself. */
    expect(notifier.delivered[0]?.task.dueAt?.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('claims no more than the batch limit, soonest first', async () => {
    for (let index = 0; index < 5; index += 1) {
      await givenTaskWithReminder({
        title: `Task ${String(index)}`,
        fireOffsetMs: -((index + 1) * MINUTE_MS),
      });
    }

    const result = await runReminderTick({
      unitOfWork: backend.unitOfWork,
      notifier,
      clock,
      batchLimit: 2,
    });

    expect(result.claimed).toBe(2);
    /* Offsets are negative, so the largest magnitude is the oldest. */
    expect(notifier.delivered.map((item) => item.task.title)).toEqual(['Task 4', 'Task 3']);
  });
});

describe('exactly-once delivery', () => {
  it('sends one email when the tick runs twice over the same reminder', async () => {
    await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });

    const first = await tick();
    const second = await tick();

    expect(first.delivered).toBe(1);
    expect(second).toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(notifier.delivered).toHaveLength(1);
  });

  it('still sends only one when the second tick happens much later', async () => {
    await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });

    await tick();
    clock.advance(7 * 24 * HOUR_MS);
    await tick();

    expect(notifier.delivered).toHaveLength(1);
  });
});

describe('recovery after downtime', () => {
  it('delivers a reminder that came due while the scheduler was stopped', async () => {
    /* The scheduler is not running. The reminder's firing time passes. */
    await givenTaskWithReminder({ fireOffsetMs: 30 * MINUTE_MS });
    const beforeRestart = await tick();
    expect(beforeRestart.claimed).toBe(0);

    /* Six hours of downtime, then the process starts and ticks. */
    clock.advance(6 * HOUR_MS);
    const afterRestart = await tick();

    expect(afterRestart).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(notifier.delivered).toHaveLength(1);
  });

  it('delivers a long backlog on the first tick after restart', async () => {
    for (let index = 0; index < 4; index += 1) {
      await givenTaskWithReminder({
        title: `Missed ${String(index)}`,
        fireOffsetMs: -((index + 1) * HOUR_MS),
      });
    }

    const result = await tick();

    expect(result.delivered).toBe(4);
  });
});

describe('failure handling', () => {
  it('records the reason, counts the attempt, and leaves the reminder unsent', async () => {
    const { task, reminder } = await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll('SMTP connection refused');

    const result = await tick();

    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    const stored = backend.store.reminders.get(reminder.id);
    expect(stored).toMatchObject({ attempts: 1, lastError: 'SMTP connection refused', sentAt: null });
    /* Still outstanding, so the next tick will try again. */
    await expect(backend.repositories.reminders.findPendingForTask(task.id)).resolves.not.toBeNull();
  });

  it('retries on the next tick and succeeds once the transport recovers', async () => {
    await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll();

    await tick();
    expect(notifier.delivered).toHaveLength(0);

    notifier.succeedAgain();
    const result = await tick();

    expect(result.delivered).toBe(1);
    expect(notifier.delivered).toHaveLength(1);
  });

  it(`gives up after ${String(MAX_DELIVERY_ATTEMPTS)} attempts`, async () => {
    const { reminder } = await givenTaskWithReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll();

    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const result = await tick();
      expect(result.failed).toBe(1);
    }

    /* Exhausted: no longer claimed at all, rather than claimed and discarded. */
    const afterExhaustion = await tick();
    expect(afterExhaustion).toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(backend.store.reminders.get(reminder.id)?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(backend.store.reminders.get(reminder.id)?.sentAt).toBeNull();
  });

  it('one failing reminder does not stop the others in the batch', async () => {
    const failing = await givenTaskWithReminder({ title: 'Fails', fireOffsetMs: -2 * MINUTE_MS });
    await givenTaskWithReminder({ title: 'Succeeds', fireOffsetMs: -MINUTE_MS });
    notifier.failFor(failing.reminder.id);

    const result = await tick();

    expect(result).toEqual({ claimed: 2, delivered: 1, failed: 1 });
    expect(notifier.delivered.map((item) => item.task.title)).toEqual(['Succeeds']);
    /* The failure was recorded rather than rolling the whole tick back. */
    expect(backend.store.reminders.get(failing.reminder.id)?.attempts).toBe(1);
  });
});
