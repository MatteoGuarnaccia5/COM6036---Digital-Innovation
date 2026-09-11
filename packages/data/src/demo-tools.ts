/**
 * Support for the demonstration script, and nothing else.
 *
 * This lives in the data access layer because it issues SQL, and SQL lives
 * here. It is deliberately *not* part of `ReminderRepository`: business logic
 * has no reason to drag a reminder's firing time into the past, so putting this
 * on the port would widen the contract that every implementation - including
 * the in-memory fakes - has to satisfy, in order to serve a demo.
 *
 * See the README: `docker compose exec scheduler node
 * apps/scheduler/dist/trigger-reminder.js` makes the next tick fire a reminder
 * immediately, so reminder delivery can be shown without waiting for a real
 * deadline to come round.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { reminders, tasks, users } from './schema.js';

export interface ShiftReminderOptions {
  /** Picks the earliest pending reminder whose task title contains this. */
  readonly titleContains?: string | undefined;
  /** Or name the reminder outright. */
  readonly reminderId?: string | undefined;
  /** How far into the past to move it. A minute is plenty. */
  readonly secondsIntoThePast?: number | undefined;
}

export interface ShiftedReminder {
  readonly reminderId: string;
  readonly taskTitle: string;
  readonly recipientEmail: string;
  readonly previousFireAt: Date;
  readonly newFireAt: Date;
}

/**
 * Moves one undelivered reminder's firing time into the past so that the next
 * tick claims it.
 *
 * Note that this only changes *when* the reminder is due. It does not mark it
 * sent, bypass the scheduler, or send anything itself - the scheduler still
 * claims it, delivers it and stamps it through the ordinary path, which is
 * precisely what makes the demonstration worth watching.
 *
 * @returns The reminder that was moved, or null if there was no pending one.
 */
export async function shiftReminderIntoThePast(
  db: Database,
  options: ShiftReminderOptions = {},
): Promise<ShiftedReminder | null> {
  const secondsIntoThePast = options.secondsIntoThePast ?? 60;

  return db.transaction(async (tx) => {
    const conditions = [isNull(reminders.sentAt)];
    if (options.reminderId !== undefined) {
      conditions.push(eq(reminders.id, options.reminderId));
    }
    if (options.titleContains !== undefined) {
      conditions.push(sql`${tasks.title} ILIKE ${`%${options.titleContains}%`}`);
    }

    const [candidate] = await tx
      .select({
        id: reminders.id,
        fireAt: reminders.fireAt,
        title: tasks.title,
        email: users.email,
      })
      .from(reminders)
      .innerJoin(tasks, eq(tasks.id, reminders.taskId))
      .innerJoin(users, eq(users.id, tasks.userId))
      .where(and(...conditions))
      .orderBy(asc(reminders.fireAt))
      .limit(1);

    if (candidate === undefined) return null;

    const newFireAt = new Date(Date.now() - secondsIntoThePast * 1000);

    await tx.update(reminders).set({ fireAt: newFireAt }).where(eq(reminders.id, candidate.id));

    return {
      reminderId: candidate.id,
      taskTitle: candidate.title,
      recipientEmail: candidate.email,
      previousFireAt: candidate.fireAt,
      newFireAt,
    };
  });
}
