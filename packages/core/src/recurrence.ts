/**
 * FR4 - recurrence arithmetic.
 *
 * ## Everything here is UTC instant arithmetic
 *
 * These functions never construct or read a local date. `daily` means "exactly
 * 24 hours later", not "the same wall-clock time tomorrow", and the same
 * reasoning applies to `weekly`, `monthly` and `every:Nd`. That is a deliberate
 * consequence of the layering: the business logic layer has no access to a
 * user's timezone, so it cannot preserve a local wall-clock time and does not
 * pretend to.
 *
 * The visible effect is at a daylight-saving transition. A task due at 09:00
 * London on 28 March 2026 recurs to 09:00 UTC on 29 March, which is 10:00
 * London, because the clocks moved forward overnight. The instant advances by
 * exactly 24 hours; the local time the user reads shifts by an hour. This is
 * intended, and `tests/unit/recurrence.test.ts` pins it.
 *
 * What must *not* happen is the calculation quietly picking up the host
 * machine's timezone, which is how this kind of code usually rots: it passes on
 * a developer's laptop in London and produces different answers on a CI runner
 * in New York. Every operation below uses the `getUTC*` accessors and
 * `Date.UTC`, and the test suite runs the same cases under several values of
 * `TZ` to prove the results do not depend on it.
 */
import { everyNDays, type RecurrenceRule } from './domain/types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Advances an instant by one period of the given rule.
 *
 * `monthly` keeps the same day of the month where that day exists, and clamps
 * to the last day where it does not: 31 January becomes 28 February (29 in a
 * leap year). Note that clamping is applied to each step in turn, so a series
 * starting on the 31st settles onto the 28th rather than springing back - the
 * arithmetic is a function of the previous occurrence, not of the first one.
 *
 * @param from An instant in UTC - a task's deadline.
 * @returns The next instant in UTC.
 */
export function nextOccurrence(from: Date, rule: RecurrenceRule): Date {
  if (Number.isNaN(from.getTime())) {
    throw new RangeError('nextOccurrence received an invalid date');
  }

  switch (rule) {
    case 'daily':
      return new Date(from.getTime() + DAY_MS);
    case 'weekly':
      return new Date(from.getTime() + 7 * DAY_MS);
    case 'monthly':
      return addOneMonthUtc(from);
    default: {
      const days = everyNDays(rule);
      if (days === null) {
        /* Unreachable for a value that passed parseRecurrenceRule, but a
           corrupt rule should fail loudly rather than silently do nothing. */
        throw new RangeError(`Unsupported recurrence rule: ${String(rule)}`);
      }
      return new Date(from.getTime() + days * DAY_MS);
    }
  }
}

/** Days in a given UTC month. Day 0 of the following month is the last of this one. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addOneMonthUtc(from: Date): Date {
  const year = from.getUTCFullYear();
  const monthIndex = from.getUTCMonth();
  const dayOfMonth = from.getUTCDate();

  /* Date.UTC rolls a month index of 12 into January of the following year. */
  const targetYear = monthIndex === 11 ? year + 1 : year;
  const targetMonth = monthIndex === 11 ? 0 : monthIndex + 1;
  const clampedDay = Math.min(dayOfMonth, daysInUtcMonth(targetYear, targetMonth));

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}
