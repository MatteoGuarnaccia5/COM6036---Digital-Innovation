/**
 * Row-to-domain mapping.
 *
 * The boundary between "what the database returns" and "what the business
 * logic understands" is drawn here, in one file. Nothing above this layer ever
 * sees a Drizzle row type, which is what allows the persistence strategy to
 * change without touching a business rule.
 */
import { parseRecurrenceRule, type Reminder, type Task, type User } from '@tasks/core';

import type { ReminderRow, TaskRow, UserRow } from '../schema.js';

/**
 * The `tasks_recurrence_valid` CHECK constraint means an unparseable value
 * cannot reach here. If one somehow does, the data is corrupt and failing loudly
 * is better than silently treating the task as non-recurring.
 */
function toRecurrence(value: string | null, taskId: string): Task['recurrence'] {
  if (value === null) return null;

  const rule = parseRecurrenceRule(value);
  if (rule === null) {
    throw new Error(`Task ${taskId} has an unrecognised recurrence rule: ${value}`);
  }
  return rule;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    timezone: row.timezone,
    createdAt: row.createdAt,
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    dueAt: row.dueAt,
    priority: row.priority,
    status: row.status,
    recurrence: toRecurrence(row.recurrence, row.id),
    parentTaskId: row.parentTaskId,
    reminderOffsetMinutes: row.reminderOffsetMinutes,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    taskId: row.taskId,
    /* `reminders.due_at` is the firing time, not a deadline. See schema.ts. */
    fireAt: row.fireAt,
    sentAt: row.sentAt,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}
