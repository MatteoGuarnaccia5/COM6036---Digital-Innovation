/**
 * FR5 - one pass of the reminder scheduler.
 *
 * This function is the centrepiece of the system and it lives in the business
 * logic layer, not in the worker process. `apps/scheduler` is a thin shell: it
 * owns a timer, a database pool and an email transport, and calls this. That
 * separation is what allows the tick to be tested without a scheduler running,
 * and why the same logic could be driven by a cron job or a CLI without change.
 *
 * ## Sequence
 *
 * Everything below happens inside one transaction:
 *
 *   1. Claim up to `batchLimit` reminders that are due and undelivered, taking
 *      a row lock on each and skipping any another worker already holds.
 *   2. For each, ask the notifier to deliver it.
 *   3. Stamp `sent_at` - in the same transaction that claimed the row.
 *   4. On failure, increment `attempts` and record the reason, leaving
 *      `sent_at` null so the next tick tries again, until `maxAttempts`.
 *
 * ## Recovery is not a feature
 *
 * A reminder whose firing time passed while the scheduler was stopped is
 * delivered on the next tick after it starts, and there is no code here that
 * makes that happen. The claim asks for everything due and undelivered; a
 * reminder that came due during downtime matches that on the next pass exactly
 * as it would have at the time. Catch-up logic would be a second code path
 * doing what the first already does.
 *
 * ## What "exactly once" does and does not mean
 *
 * Two ticks over the same due reminder send one email. The row lock stops a
 * concurrent worker from claiming it, `sent_at IS NULL` stops a later tick from
 * re-claiming it, and `markSent` will not stamp a row twice. Both properties
 * are tested against a real database.
 *
 * The honest limit: delivery is an external side effect that cannot join the
 * database transaction. If the process died between SMTP accepting a message
 * and the transaction committing, the stamp would be rolled back and the next
 * tick would send a second copy. The guarantee is therefore at-least-once
 * delivery with single delivery on every path that does not involve a crash
 * inside that window. Closing it entirely would need the transport to accept an
 * idempotency key, which SMTP does not offer.
 *
 * A failing delivery must never propagate out of the loop: throwing would roll
 * the transaction back and discard the very `attempts` increment that stops a
 * doomed reminder retrying for ever.
 */
import type { UnitOfWork } from '../ports/repositories.js';
import type { Clock, ReminderNotifier } from '../ports/services.js';

/** Reminders claimed per tick. The specification's figure. */
export const REMINDER_BATCH_LIMIT = 50;
/** Deliveries attempted before a reminder is abandoned. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface ReminderTickDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly notifier: ReminderNotifier;
  readonly clock: Clock;
  readonly batchLimit?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

export interface ReminderTickResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runReminderTick(
  dependencies: ReminderTickDependencies,
): Promise<ReminderTickResult> {
  const {
    unitOfWork,
    notifier,
    clock,
    batchLimit = REMINDER_BATCH_LIMIT,
    maxAttempts = MAX_DELIVERY_ATTEMPTS,
  } = dependencies;

  return unitOfWork.run(async (repositories) => {
    const due = await repositories.reminders.claimDue({
      now: clock.now(),
      limit: batchLimit,
      maxAttempts,
    });

    let delivered = 0;
    let failed = 0;

    for (const reminder of due) {
      try {
        await notifier.notify(reminder);
        await repositories.reminders.markSent(reminder.reminderId, clock.now());
        delivered += 1;
      } catch (error) {
        /* Caught, never rethrown - see the note above about rollback. */
        await repositories.reminders.recordFailure(reminder.reminderId, describeFailure(error));
        failed += 1;
      }
    }

    return { claimed: due.length, delivered, failed };
  });
}
