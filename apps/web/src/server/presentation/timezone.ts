/**
 * Timezone conversion. This file is the boundary.
 *
 * Everything below the presentation layer works in UTC and only in UTC: the
 * business logic layer has no timezone parameter anywhere in its API, and the
 * database stores `timestamptz`. The translation between a user's wall clock
 * and a UTC instant happens here, on the way in and on the way out, and nowhere
 * else in the codebase.
 *
 * There is no date library. `Intl.DateTimeFormat` already carries the IANA
 * database, and the arithmetic needed on top of it is short enough to write and
 * test directly - which keeps the dependency list honest.
 *
 * ## What the API accepts
 *
 * A deadline arrives as a naive wall-clock string, `YYYY-MM-DDTHH:mm`, exactly
 * as an `<input type="datetime-local">` produces it. It carries no offset, and
 * is interpreted in the timezone on the authenticated user's account. That is a
 * deliberate choice: it makes the conversion real and observable rather than
 * letting the client pre-compute an instant and reducing this layer to a
 * pass-through.
 */

/** `YYYY-MM-DDTHH:mm`, with optional seconds. */
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset, in milliseconds, that the given zone was observing at the given
 * instant. Positive east of Greenwich.
 *
 * Derived by asking Intl what the wall clock read at that instant and comparing
 * it with the instant itself, which is the only way to get a zone's offset for
 * an arbitrary date without shipping a copy of the IANA database.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const valueOf = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  /* Some runtimes render midnight as hour 24 under hour12: false. */
  const hour = valueOf('hour') % 24;

  const wallClockAsUtc = Date.UTC(
    valueOf('year'),
    valueOf('month') - 1,
    valueOf('day'),
    hour,
    valueOf('minute'),
    valueOf('second'),
  );

  return wallClockAsUtc - instant.getTime();
}

export class InvalidLocalDateTimeError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid date and time`);
    this.name = 'InvalidLocalDateTimeError';
  }
}

/**
 * Converts a naive wall-clock string in the given zone to a UTC instant.
 *
 * The offset a zone observes depends on the instant, and the instant is what we
 * are trying to find, so this guesses and corrects: read the offset at the
 * naive time treated as UTC, apply it, then re-read the offset at the resulting
 * instant. One correction is enough for every real zone, because offsets shift
 * by at most a couple of hours and never twice within that window.
 *
 * Two awkward cases, both of which have a defined answer here:
 *
 *  - **The clocks went forward** and the requested wall clock never existed
 *    (01:30 on 29 March 2026 in London). The corrected offset does not
 *    round-trip, so the first estimate is kept, which lands just after the gap.
 *  - **The clocks went back** and the wall clock happened twice (01:30 on 25
 *    October 2026). The first occurrence is chosen, i.e. still on summer time.
 */
export function parseLocalDateTime(value: string, timeZone: string): Date {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value.trim());
  if (match === null) throw new InvalidLocalDateTimeError(value);

  const [, year, month, day, hour, minute, second] = match;
  const naiveAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
  );

  if (Number.isNaN(naiveAsUtc)) throw new InvalidLocalDateTimeError(value);

  const firstEstimate = naiveAsUtc - zoneOffsetMs(new Date(naiveAsUtc), timeZone);
  const correctedOffset = zoneOffsetMs(new Date(firstEstimate), timeZone);
  const secondEstimate = naiveAsUtc - correctedOffset;

  /* If applying the corrected offset reproduces the requested wall clock, use
     it. If it does not, the requested time falls in a spring-forward gap and
     the first estimate is the instant immediately after it. */
  const roundTrips =
    naiveAsUtc - zoneOffsetMs(new Date(secondEstimate), timeZone) === secondEstimate;

  const instant = new Date(roundTrips ? secondEstimate : firstEstimate);
  if (Number.isNaN(instant.getTime())) throw new InvalidLocalDateTimeError(value);

  /* Reject a date that does not exist at all, such as 31 February, which
     Date.UTC would silently roll into the following month. */
  const rendered = toLocalInputValue(instant, timeZone);
  if (rendered.slice(0, 10) !== `${year!}-${month!}-${day!}` && roundTrips) {
    throw new InvalidLocalDateTimeError(value);
  }

  return instant;
}

/**
 * Renders a UTC instant as `YYYY-MM-DDTHH:mm` in the given zone - the format an
 * `<input type="datetime-local">` expects, so an edit form round-trips.
 */
export function toLocalInputValue(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const valueOf = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '00';

  const hour = String(Number(valueOf('hour')) % 24).padStart(2, '0');

  return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')}T${hour}:${valueOf('minute')}`;
}

/** A readable rendering for display, e.g. `Wed 6 May 2026, 17:00`. */
export function formatForDisplay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}
