/**
 * The scheduler, against a real PostgreSQL server.
 *
 * The unit suite already pins the delivery *rules* using in-memory fakes. This
 * suite exists for the things a fake cannot express, because they are
 * properties of the database rather than of the code: `FOR UPDATE SKIP LOCKED`,
 * transaction boundaries, and what a second worker sees while a first one is
 * mid-delivery. Those are the mechanisms the two required properties -
 * exactly-once and recovery - actually rest on, so they are tested where they
 * live.
 */
import { runReminderTick, type Reminder, type Task } from '@tasks/core';
import { createRepositories, createUnitOfWork } from '@tasks/data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupTestDatabase, type TestDatabase } from '../support/database.js';
import { createFakeClock, type FakeClock } from '../support/fakes/fake-clock.js';
import {
  createRecordingNotifier,
  type RecordingNotifier,
} from '../support/fakes/recording-notifier.js';

const NOW = new Date('2026-05-04T10:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

let database: TestDatabase;
let clock: FakeClock;
let notifier: RecordingNotifier;
let userId: string;

const tick = async (overrides: { maxAttempts?: number; batchLimit?: number } = {}) =>
  runReminderTick({
    unitOfWork: createUnitOfWork(database.db),
    notifier,
    clock,
    ...overrides,
  });

async function givenReminder(options: {
  title?: string;
  /** Firing time relative to NOW. Negative is already due. */
  fireOffsetMs: number;
}): Promise<{ task: Task; reminder: Reminder }> {
  const repositories = createRepositories(database.db);

  const task = await repositories.tasks.create({
    userId,
    title: options.title ?? 'Submit the report',
    description: null,
    dueAt: new Date(NOW.getTime() + 2 * HOUR_MS),
    priority: 'high',
    recurrence: null,
    parentTaskId: null,
    reminderOffsetMinutes: 60,
  });

  const reminder = await repositories.reminders.create({
    taskId: task.id,
    fireAt: new Date(NOW.getTime() + options.fireOffsetMs),
  });

  return { task, reminder };
}

const readReminder = async (id: string): Promise<{ sent_at: Date | null; attempts: number; last_error: string | null }> => {
  const { rows } = await database.pool.query<{
    sent_at: Date | null;
    attempts: number;
    last_error: string | null;
  }>('SELECT sent_at, attempts, last_error FROM reminders WHERE id = $1', [id]);

  const row = rows[0];
  if (row === undefined) throw new Error(`No reminder ${id}`);
  return row;
};

beforeAll(async () => {
  database = await setupTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  clock = createFakeClock(NOW);
  notifier = createRecordingNotifier();

  const user = await createRepositories(database.db).users.create({
    email: 'demo@example.com',
    passwordHash: 'hash',
    timezone: 'Europe/London',
  });
  userId = user.id;
});

describe('exactly-once delivery', () => {
  it('sends one email when the tick runs twice over the same due reminder', async () => {
    const { reminder } = await givenReminder({ fireOffsetMs: -MINUTE_MS });

    const first = await tick();
    const second = await tick();

    expect(first).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(second).toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(notifier.delivered).toHaveLength(1);
    expect((await readReminder(reminder.id)).sent_at).not.toBeNull();
  });

  it('sends one email per reminder when two ticks run concurrently', async () => {
    /*
     * The case SKIP LOCKED exists for. Two workers claim from the same backlog
     * at the same instant; between them each reminder must go out once. With a
     * plain SELECT the two would claim overlapping rows and double-send, and
     * with FOR UPDATE alone the second would block instead of getting on with
     * the rest of the queue.
     */
    for (let index = 0; index < 6; index += 1) {
      await givenReminder({ title: `Task ${String(index)}`, fireOffsetMs: -MINUTE_MS });
    }

    const [a, b] = await Promise.all([tick(), tick()]);

    expect(a.claimed + b.claimed).toBe(6);
    expect(a.delivered + b.delivered).toBe(6);
    expect(notifier.delivered).toHaveLength(6);

    const titles = notifier.delivered.map((item) => item.task.title).sort();
    expect(new Set(titles).size).toBe(6);

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM reminders WHERE sent_at IS NULL',
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('holds the row locked and stamps sent_at in the claiming transaction', async () => {
    /*
     * This is the specification's "stamp sent_at within the same transaction as
     * the claim", asserted directly rather than inferred.
     *
     * While the first tick is inside `notify`, a second connection is used to
     * check two things: the reminder is not yet marked sent - the stamp is
     * uncommitted, so no other session can observe it - and a concurrent tick
     * claims nothing, because the row lock is still held. Only when the first
     * tick's transaction commits does either become visible.
     */
    const { reminder } = await givenReminder({ fireOffsetMs: -MINUTE_MS });

    let releaseDelivery = (): void => {};
    const deliveryStarted = new Promise<void>((resolveStarted) => {
      const blocked = new Promise<void>((resolveRelease) => {
        releaseDelivery = resolveRelease;
      });
      notifier.notify = async (): Promise<void> => {
        resolveStarted();
        await blocked;
      };
    });

    const inFlight = tick();
    await deliveryStarted;

    /* Mid-delivery: uncommitted, and invisible to everyone else. */
    expect((await readReminder(reminder.id)).sent_at).toBeNull();

    const concurrent = await tick();
    expect(concurrent).toEqual({ claimed: 0, delivered: 0, failed: 0 });

    releaseDelivery();
    const result = await inFlight;

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect((await readReminder(reminder.id)).sent_at).not.toBeNull();
  });
});

describe('recovery after downtime', () => {
  it('delivers a reminder whose firing time passed while the scheduler was stopped', async () => {
    /*
     * No catch-up logic exists, and none is needed. The claim asks for
     * everything due and undelivered; a reminder that came due during an outage
     * matches that on the next tick exactly as it would have at the time.
     */
    await givenReminder({ title: 'Missed during downtime', fireOffsetMs: -3 * HOUR_MS });

    const result = await tick();

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(notifier.delivered[0]?.task.title).toBe('Missed during downtime');
  });

  it('delivers a whole backlog on the first tick after restarting', async () => {
    for (let hoursAgo = 1; hoursAgo <= 5; hoursAgo += 1) {
      await givenReminder({ title: `Missed ${String(hoursAgo)}h ago`, fireOffsetMs: -hoursAgo * HOUR_MS });
    }

    const result = await tick();

    expect(result.delivered).toBe(5);
    /* Oldest first, so a backlog drains in the order it accumulated. */
    expect(notifier.delivered.map((item) => item.task.title)).toEqual([
      'Missed 5h ago',
      'Missed 4h ago',
      'Missed 3h ago',
      'Missed 2h ago',
      'Missed 1h ago',
    ]);
  });

  it('leaves a reminder alone until its firing time arrives', async () => {
    await givenReminder({ fireOffsetMs: 30 * MINUTE_MS });

    expect(await tick()).toEqual({ claimed: 0, delivered: 0, failed: 0 });

    /* The scheduler is stopped for an hour. On its next tick, it is due. */
    clock.advance(HOUR_MS);

    expect(await tick()).toEqual({ claimed: 1, delivered: 1, failed: 0 });
  });
});

describe('failure and retry', () => {
  it('records the reason and retries on the next tick, without marking it sent', async () => {
    const { reminder } = await givenReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll('SMTP connection refused');

    const failed = await tick();
    expect(failed).toEqual({ claimed: 1, delivered: 0, failed: 1 });

    const afterFailure = await readReminder(reminder.id);
    expect(afterFailure).toMatchObject({
      sent_at: null,
      attempts: 1,
      last_error: 'SMTP connection refused',
    });

    notifier.succeedAgain();
    expect(await tick()).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect((await readReminder(reminder.id)).sent_at).not.toBeNull();
  });

  it('the attempt counter survives, so a failure does not roll the tick back', async () => {
    /* If the tick let a delivery failure propagate, the transaction would roll
       back and the increment would be lost - and the reminder would retry for
       ever without ever exhausting its attempts. */
    const { reminder } = await givenReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll();

    await tick();
    await tick();
    await tick();

    expect((await readReminder(reminder.id)).attempts).toBe(3);
  });

  it('gives up after five attempts and stops claiming it', async () => {
    const { reminder } = await givenReminder({ fireOffsetMs: -MINUTE_MS });
    notifier.failAll();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await tick()).failed).toBe(1);
    }

    /* Exhausted: no longer selected at all, rather than fetched and discarded
       on every tick from now until the end of time. */
    expect(await tick()).toEqual({ claimed: 0, delivered: 0, failed: 0 });

    const abandoned = await readReminder(reminder.id);
    expect(abandoned.attempts).toBe(5);
    expect(abandoned.sent_at).toBeNull();
  });

  it('one failing reminder does not prevent the others in the batch', async () => {
    const failing = await givenReminder({ title: 'Fails', fireOffsetMs: -2 * MINUTE_MS });
    await givenReminder({ title: 'Succeeds', fireOffsetMs: -MINUTE_MS });
    notifier.failFor(failing.reminder.id);

    const result = await tick();

    expect(result).toEqual({ claimed: 2, delivered: 1, failed: 1 });
    expect(notifier.delivered.map((item) => item.task.title)).toEqual(['Succeeds']);
    expect((await readReminder(failing.reminder.id)).attempts).toBe(1);
  });
});

describe('batching', () => {
  it('claims no more than the batch limit in one tick', async () => {
    for (let index = 0; index < 5; index += 1) {
      await givenReminder({ title: `Task ${String(index)}`, fireOffsetMs: -MINUTE_MS });
    }

    expect((await tick({ batchLimit: 2 })).claimed).toBe(2);
    expect((await tick({ batchLimit: 2 })).claimed).toBe(2);
    expect((await tick({ batchLimit: 2 })).claimed).toBe(1);
    expect((await tick({ batchLimit: 2 })).claimed).toBe(0);
    expect(notifier.delivered).toHaveLength(5);
  });
});
