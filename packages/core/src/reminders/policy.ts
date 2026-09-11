/**
 * FR5 - when a reminder should fire, and keeping that in step with its task.
 *
 * The rule is one line: a reminder fires at the task's deadline minus the
 * task's offset. Everything else here is reconciliation - making the stored
 * reminder row agree with the task's current state after any change.
 */
import type { Repositories } from '../ports/repositories.js';
import type { Task } from '../domain/types.js';

const MINUTE_MS = 60_000;

/**
 * @param dueAt The task's DEADLINE, in UTC.
 * @returns The reminder's FIRING time, in UTC.
 */
export function computeReminderFireTime(dueAt: Date, reminderOffsetMinutes: number): Date {
  return new Date(dueAt.getTime() - reminderOffsetMinutes * MINUTE_MS);
}

/**
 * Brings a task's reminder into line with the task.
 *
 *   - open task with a deadline  -> exactly one pending reminder, at the right time
 *   - deadline moved             -> the pending reminder moves with it
 *   - deadline removed           -> the pending reminder is deleted
 *   - task completed or deleted  -> the pending reminder is deleted
 *
 * Delivered reminders are never touched: they are the delivery history, and a
 * sent email cannot be unsent.
 *
 * A firing time that has already passed is written rather than skipped. The
 * scheduler's claim query selects everything due and undelivered, so such a
 * reminder simply goes out on the next tick - the same mechanism that recovers
 * reminders which came due while the scheduler was stopped. Suppressing them
 * here would be a special case that quietly loses reminders instead.
 *
 * Call this inside a unit of work, so the task and its reminder change together
 * or not at all.
 */
export async function synchroniseReminder(
  repositories: Repositories,
  task: Task,
): Promise<void> {
  const deadline = task.dueAt;
  const shouldHaveReminder = task.status === 'open' && deadline !== null;

  if (!shouldHaveReminder) {
    await repositories.reminders.deletePendingForTask(task.id);
    return;
  }

  const fireAt = computeReminderFireTime(deadline, task.reminderOffsetMinutes);
  const pending = await repositories.reminders.findPendingForTask(task.id);

  if (pending === null) {
    await repositories.reminders.create({ taskId: task.id, fireAt });
    return;
  }

  if (pending.fireAt.getTime() !== fireAt.getTime()) {
    await repositories.reminders.updateFireTime(pending.id, fireAt);
  }
}
