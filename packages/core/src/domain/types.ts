/**
 * The domain model, expressed in plain TypeScript.
 *
 * These types are the vocabulary shared by every layer. They are deliberately
 * not the ORM's row types: the data access layer maps its rows onto these, so
 * a change to the persistence strategy cannot ripple upwards.
 *
 * ## Time
 *
 * Every `Date` in this file is an instant in UTC. This layer has no notion of a
 * user's local time, and no function here accepts or returns a formatted date
 * string. Conversion to and from a user's timezone happens exclusively in the
 * presentation layer.
 */

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskStatus = 'open' | 'done';

/**
 * FR4. Either one of three keywords, or `every:Nd` for a whole number of days.
 * Values reaching the domain are validated by {@link parseRecurrenceRule}.
 */
export type RecurrenceRule = 'daily' | 'weekly' | 'monthly' | `every:${number}d`;

export const RECURRENCE_KEYWORDS = ['daily', 'weekly', 'monthly'] as const;

/** `every:` followed by a positive whole number of days. No leading zeros. */
const EVERY_N_DAYS_PATTERN = /^every:([1-9][0-9]*)d$/;

/** Returns the rule if the string is a valid recurrence, otherwise null. */
export function parseRecurrenceRule(value: string): RecurrenceRule | null {
  if ((RECURRENCE_KEYWORDS as readonly string[]).includes(value)) {
    return value as RecurrenceRule;
  }
  return EVERY_N_DAYS_PATTERN.test(value) ? (value as RecurrenceRule) : null;
}

/** The day count of an `every:Nd` rule, or null for the keyword rules. */
export function everyNDays(rule: RecurrenceRule): number | null {
  const match = EVERY_N_DAYS_PATTERN.exec(rule);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  /**
   * IANA zone name, e.g. `Europe/London`. Carried through the layers as an
   * opaque string; only the presentation layer ever interprets it.
   */
  readonly timezone: string;
  readonly createdAt: Date;
}

export interface Task {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly description: string | null;
  /** The task's DEADLINE, in UTC. Not to be confused with {@link Reminder.fireAt}. */
  readonly dueAt: Date | null;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly recurrence: RecurrenceRule | null;
  /** Set on a generated occurrence; points at the root task of the series. */
  readonly parentTaskId: string | null;
  readonly reminderOffsetMinutes: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface Reminder {
  readonly id: string;
  readonly taskId: string;
  /**
   * When the reminder should FIRE, in UTC - the task's deadline minus its
   * reminder offset. Stored in the column `reminders.due_at`, which is why the
   * field is named differently from {@link Task.dueAt}.
   */
  readonly fireAt: Date;
  /** Null until delivered. Stamped inside the transaction that claimed the row. */
  readonly sentAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly timezone: string;
}

export interface NewTask {
  readonly userId: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueAt: Date | null;
  readonly priority: TaskPriority;
  readonly recurrence: RecurrenceRule | null;
  readonly parentTaskId: string | null;
  readonly reminderOffsetMinutes: number;
}

/**
 * A partial update. A property that is absent is left alone; a property set to
 * `null` clears the field. The explicit `| undefined` is required because the
 * project compiles with `exactOptionalPropertyTypes`.
 */
export interface TaskChanges {
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly dueAt?: Date | null | undefined;
  readonly priority?: TaskPriority | undefined;
  readonly recurrence?: RecurrenceRule | null | undefined;
  readonly reminderOffsetMinutes?: number | undefined;
  readonly status?: TaskStatus | undefined;
  readonly completedAt?: Date | null | undefined;
}

export interface NewReminder {
  readonly taskId: string;
  /** The FIRING time, in UTC. */
  readonly fireAt: Date;
}

/**
 * Everything the scheduler needs to deliver one reminder, gathered in a single
 * read so the claiming transaction is short. The data access layer produces
 * this with a join; business logic treats it as an opaque record.
 */
export interface DueReminder {
  readonly reminderId: string;
  /** The reminder's firing time, in UTC. */
  readonly fireAt: Date;
  readonly attempts: number;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    /** The task's deadline, in UTC. */
    readonly dueAt: Date | null;
    readonly priority: TaskPriority;
  };
  readonly recipient: {
    readonly email: string;
    /** IANA zone, for the notifier to format the deadline with. */
    readonly timezone: string;
  };
}
