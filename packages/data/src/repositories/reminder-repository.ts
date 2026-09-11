import type {
  ClaimDueRemindersInput,
  DueReminder,
  NewReminder,
  Reminder,
  ReminderRepository,
  TaskPriority,
} from '@tasks/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { DatabaseExecutor } from '../client.js';
import { reminders } from '../schema.js';
import { toReminder } from './mappers.js';

/**
 * The shape of one row returned by the claim query.
 *
 * The timestamps are typed `string | Date` rather than `Date` because that is
 * the truth. Drizzle configures node-postgres to hand timestamps back as
 * strings so that it can apply its own column mapping in typed queries - but
 * `execute()` runs raw SQL and so bypasses that mapping, yielding
 * `"2026-09-08 10:00:00+00"` where a typed `select()` yields a `Date`.
 * {@link toUtcDate} restores the port's promise that every instant crossing
 * this boundary is a `Date`.
 */
interface DueReminderRow extends Record<string, unknown> {
  reminder_id: string;
  fire_at: string | Date;
  attempts: number;
  task_id: string;
  task_title: string;
  task_description: string | null;
  task_due_at: string | Date | null;
  task_priority: string;
  recipient_email: string;
  recipient_timezone: string;
}

/**
 * Postgres renders a `timestamptz` as `2026-09-08 10:00:00+00`, which
 * JavaScript's lenient date parser reads correctly. Note that "tidying" it into
 * ISO form first would break it: `2026-09-08T10:00:00+00` is not valid ISO
 * 8601, because ISO requires a two-part offset.
 */
function toUtcDate(value: string | Date): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Could not read a timestamp from the database: ${String(value)}`);
  }
  return instant;
}

const toNullableUtcDate = (value: string | Date | null): Date | null =>
  value === null ? null : toUtcDate(value);

const PRIORITIES: readonly string[] = ['low', 'medium', 'high'];

function toPriority(value: string): TaskPriority {
  if (!PRIORITIES.includes(value)) {
    throw new Error(`Unrecognised task priority: ${value}`);
  }
  return value as TaskPriority;
}

export function createReminderRepository(executor: DatabaseExecutor): ReminderRepository {
  return {
    async findPendingForTask(taskId: string): Promise<Reminder | null> {
      const [row] = await executor
        .select()
        .from(reminders)
        .where(and(eq(reminders.taskId, taskId), isNull(reminders.sentAt)))
        .orderBy(asc(reminders.fireAt))
        .limit(1);
      return row === undefined ? null : toReminder(row);
    },

    async create(input: NewReminder): Promise<Reminder> {
      const [row] = await executor
        .insert(reminders)
        .values({ taskId: input.taskId, fireAt: input.fireAt })
        .returning();

      if (row === undefined) throw new Error('Insert into reminders returned no row');
      return toReminder(row);
    },

    async updateFireTime(reminderId: string, fireAt: Date): Promise<void> {
      await executor
        .update(reminders)
        .set({ fireAt })
        /* A delivered reminder is history and is never moved. */
        .where(and(eq(reminders.id, reminderId), isNull(reminders.sentAt)));
    },

    async deletePendingForTask(taskId: string): Promise<number> {
      const deleted = await executor
        .delete(reminders)
        .where(and(eq(reminders.taskId, taskId), isNull(reminders.sentAt)))
        .returning({ id: reminders.id });
      return deleted.length;
    },

    /**
     * The scheduler's claim.
     *
     * `FOR UPDATE OF r SKIP LOCKED` takes a row lock on the reminders it
     * returns and silently passes over any row another worker already holds,
     * so two schedulers ticking at once divide the work rather than collide
     * over it. `OF r` restricts the lock to `reminders`: the joined task and
     * user rows are only being read, and locking them would block unrelated
     * edits for the length of the delivery.
     *
     * The lock lives until the surrounding transaction ends, which is what lets
     * the caller stamp `sent_at` in the same transaction that claimed the row.
     *
     * `attempts < maxAttempts` is part of the predicate rather than a check
     * afterwards, so a reminder that has exhausted its retries stops being
     * selected at all instead of being fetched and discarded every tick.
     */
    async claimDue(input: ClaimDueRemindersInput): Promise<DueReminder[]> {
      const result = await executor.execute<DueReminderRow>(sql`
        SELECT r.id            AS reminder_id,
               r.due_at        AS fire_at,
               r.attempts      AS attempts,
               t.id            AS task_id,
               t.title         AS task_title,
               t.description   AS task_description,
               t.due_at        AS task_due_at,
               t.priority      AS task_priority,
               u.email         AS recipient_email,
               u.timezone      AS recipient_timezone
          FROM reminders r
          JOIN tasks t ON t.id = r.task_id
          JOIN users u ON u.id = t.user_id
         WHERE r.sent_at IS NULL
           AND r.due_at <= ${input.now}
           AND r.attempts < ${input.maxAttempts}
         ORDER BY r.due_at ASC
         LIMIT ${input.limit}
           FOR UPDATE OF r SKIP LOCKED
      `);

      return result.rows.map((row) => ({
        reminderId: row.reminder_id,
        fireAt: toUtcDate(row.fire_at),
        attempts: row.attempts,
        task: {
          id: row.task_id,
          title: row.task_title,
          description: row.task_description,
          dueAt: toNullableUtcDate(row.task_due_at),
          priority: toPriority(row.task_priority),
        },
        recipient: {
          email: row.recipient_email,
          timezone: row.recipient_timezone,
        },
      }));
    },

    async markSent(reminderId: string, sentAt: Date): Promise<void> {
      await executor
        .update(reminders)
        .set({ sentAt })
        /* Belt and braces alongside the row lock: a reminder already stamped
           can never be stamped a second time. */
        .where(and(eq(reminders.id, reminderId), isNull(reminders.sentAt)));
    },

    async recordFailure(reminderId: string, error: string): Promise<void> {
      await executor
        .update(reminders)
        .set({
          attempts: sql`${reminders.attempts} + 1`,
          lastError: error.slice(0, 1000),
        })
        .where(eq(reminders.id, reminderId));
    },
  };
}
