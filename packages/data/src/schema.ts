/**
 * Database schema (layer 4 as expressed in layer 3).
 *
 * Conventions, applied without exception:
 *   - snake_case column names;
 *   - every timestamp is `timestamptz` and holds UTC;
 *   - nothing below the presentation layer ever sees a local time.
 *
 * ## The two meanings of `due_at`
 *
 * `due_at` appears on both `tasks` and `reminders` and means different things:
 *
 *   - `tasks.due_at`      - the task's **deadline**: when the work is due.
 *   - `reminders.due_at`  - the reminder's **firing time**: when the email
 *                           should go out, which is the task's deadline minus
 *                           `tasks.reminder_offset_minutes`.
 *
 * The column names are fixed by the specification, so the distinction is drawn
 * in the TypeScript names instead: a task has a `dueAt`, a reminder has a
 * `fireAt` mapped onto the `due_at` column. Any code holding both at once
 * therefore cannot confuse them silently.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  type AnyPgColumn,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const taskPriority = pgEnum('task_priority', ['low', 'medium', 'high']);
export const taskStatus = pgEnum('task_status', ['open', 'done']);

const utcTimestamp = (columnName: string) =>
  timestamp(columnName, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** IANA zone name. Used by the presentation layer only, for formatting. */
    timezone: text('timezone').notNull().default('Europe/London'),
    createdAt: utcTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    /** The task's DEADLINE, in UTC. Not the reminder's firing time. */
    dueAt: utcTimestamp('due_at'),
    priority: taskPriority('priority').notNull().default('medium'),
    status: taskStatus('status').notNull().default('open'),
    /**
     * `daily` | `weekly` | `monthly` | `every:Nd`, or null for a one-off task.
     * Stored as text with a CHECK constraint rather than an enum because the
     * `every:Nd` form is open-ended.
     */
    recurrence: text('recurrence'),
    /** Set on a generated occurrence; points at the root task of the series. */
    /* `AnyPgColumn` breaks the type-level cycle a self-referencing foreign key
       would otherwise create. */
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    reminderOffsetMinutes: integer('reminder_offset_minutes').notNull().default(60),
    createdAt: utcTimestamp('created_at').notNull().defaultNow(),
    completedAt: utcTimestamp('completed_at'),
  },
  (table) => [
    /* Supports the default listing: a user's tasks ordered by deadline. */
    index('tasks_user_id_due_at_idx').on(table.userId, table.dueAt),
    index('tasks_parent_task_id_idx').on(table.parentTaskId),
    check(
      'tasks_recurrence_valid',
      sql`${table.recurrence} IS NULL
          OR ${table.recurrence} IN ('daily', 'weekly', 'monthly')
          OR ${table.recurrence} ~ '^every:[1-9][0-9]*d$'`,
    ),
    check(
      'tasks_reminder_offset_non_negative',
      sql`${table.reminderOffsetMinutes} >= 0`,
    ),
    /* A task is done exactly when it has a completion time. */
    check(
      'tasks_completed_at_matches_status',
      sql`(${table.status} = 'done') = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * The reminder's FIRING TIME, in UTC - the column is `due_at` because the
     * specification names it so, but this is not the task's deadline. See the
     * note at the top of this file.
     */
    fireAt: utcTimestamp('due_at').notNull(),
    /** Null means not yet delivered. Set once, inside the claiming transaction. */
    sentAt: utcTimestamp('sent_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: utcTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    /*
     * The scheduler's hot path is "reminders that are due and not yet sent".
     * A partial index keeps that scan proportional to the outstanding work
     * rather than to the full delivery history.
     */
    index('reminders_pending_idx')
      .on(table.fireAt)
      .where(sql`${table.sentAt} IS NULL`),
    index('reminders_task_id_idx').on(table.taskId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
