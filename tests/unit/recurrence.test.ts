/**
 * Unit tests for FR4. No database, no HTTP, no clock - `nextOccurrence` is a
 * pure function of an instant and a rule, which is the point of putting it in
 * the business logic layer.
 */
import { nextOccurrence, parseRecurrenceRule, type RecurrenceRule } from '@tasks/core';
import { afterEach, describe, expect, it } from 'vitest';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const iso = (value: Date): string => value.toISOString();

describe('parseRecurrenceRule', () => {
  it('accepts the three keywords and well-formed every:Nd rules', () => {
    for (const value of ['daily', 'weekly', 'monthly', 'every:1d', 'every:3d', 'every:365d']) {
      expect(parseRecurrenceRule(value)).toBe(value);
    }
  });

  it('rejects anything else', () => {
    for (const value of [
      '',
      'fortnightly',
      'Daily',
      'every:0d',
      'every:01d',
      'every:-3d',
      'every:3',
      'every:3w',
      'every:3.5d',
      'every: 3d',
    ]) {
      expect(parseRecurrenceRule(value)).toBeNull();
    }
  });
});

describe('nextOccurrence', () => {
  it('advances daily by exactly 24 hours', () => {
    const from = new Date('2026-05-04T09:30:00.000Z');
    expect(iso(nextOccurrence(from, 'daily'))).toBe('2026-05-05T09:30:00.000Z');
  });

  it('advances weekly by exactly 7 days', () => {
    const from = new Date('2026-05-04T09:30:00.000Z');
    expect(iso(nextOccurrence(from, 'weekly'))).toBe('2026-05-11T09:30:00.000Z');
  });

  it('advances every:Nd by N days', () => {
    const from = new Date('2026-05-04T09:30:00.000Z');
    expect(iso(nextOccurrence(from, 'every:3d'))).toBe('2026-05-07T09:30:00.000Z');
    expect(iso(nextOccurrence(from, 'every:14d'))).toBe('2026-05-18T09:30:00.000Z');
    expect(iso(nextOccurrence(from, 'every:1d'))).toBe(iso(nextOccurrence(from, 'daily')));
  });

  it('rejects an invalid date rather than producing one', () => {
    expect(() => nextOccurrence(new Date('nonsense'), 'daily')).toThrow(RangeError);
  });

  describe('monthly', () => {
    it('keeps the same day of the month and time of day', () => {
      expect(iso(nextOccurrence(new Date('2026-05-04T09:30:00.000Z'), 'monthly'))).toBe(
        '2026-06-04T09:30:00.000Z',
      );
    });

    it('rolls from December into January', () => {
      expect(iso(nextOccurrence(new Date('2026-12-15T23:45:00.000Z'), 'monthly'))).toBe(
        '2027-01-15T23:45:00.000Z',
      );
    });

    it('clamps to the last day of a shorter month', () => {
      /* 2026 is not a leap year. */
      expect(iso(nextOccurrence(new Date('2026-01-31T08:00:00.000Z'), 'monthly'))).toBe(
        '2026-02-28T08:00:00.000Z',
      );
      /* 2028 is. */
      expect(iso(nextOccurrence(new Date('2028-01-31T08:00:00.000Z'), 'monthly'))).toBe(
        '2028-02-29T08:00:00.000Z',
      );
      expect(iso(nextOccurrence(new Date('2026-03-31T08:00:00.000Z'), 'monthly'))).toBe(
        '2026-04-30T08:00:00.000Z',
      );
    });

    it('settles onto the clamped day rather than springing back', () => {
      /* Each step is computed from the previous occurrence, so a series that
         starts on the 31st stays on the 28th once February has clamped it.
         Documented behaviour, not an accident - see recurrence.ts. */
      const january = new Date('2026-01-31T08:00:00.000Z');
      const february = nextOccurrence(january, 'monthly');
      const march = nextOccurrence(february, 'monthly');

      expect(iso(february)).toBe('2026-02-28T08:00:00.000Z');
      expect(iso(march)).toBe('2026-03-28T08:00:00.000Z');
    });
  });

  describe('across a daylight-saving transition', () => {
    /*
     * British Summer Time began on 29 March 2026 and ended on 25 October 2026.
     *
     * The architecture puts every recurrence calculation in UTC, because the
     * business logic layer has no access to a user's timezone. So the instant
     * advances by exactly one period and the local wall-clock time the user
     * reads shifts by an hour across the boundary. These tests pin that
     * intended behaviour, and - more importantly - pin that the arithmetic is
     * not silently affected by the DST rules of whatever zone the machine
     * running the tests happens to be in.
     */

    it('advances by exactly 24 hours over the spring-forward boundary', () => {
      const beforeTheChange = new Date('2026-03-28T09:00:00.000Z');
      const next = nextOccurrence(beforeTheChange, 'daily');

      expect(iso(next)).toBe('2026-03-29T09:00:00.000Z');
      expect(next.getTime() - beforeTheChange.getTime()).toBe(DAY_MS);
    });

    it('advances by exactly 24 hours over the autumn-back boundary', () => {
      const beforeTheChange = new Date('2026-10-24T09:00:00.000Z');
      const next = nextOccurrence(beforeTheChange, 'daily');

      expect(iso(next)).toBe('2026-10-25T09:00:00.000Z');
      expect(next.getTime() - beforeTheChange.getTime()).toBe(DAY_MS);
    });

    it('advances weekly across the boundary by exactly seven days', () => {
      const before = new Date('2026-03-26T07:15:00.000Z');
      const next = nextOccurrence(before, 'weekly');

      expect(iso(next)).toBe('2026-04-02T07:15:00.000Z');
      expect(next.getTime() - before.getTime()).toBe(7 * DAY_MS);
    });

    it('advances monthly across the boundary without drifting a day', () => {
      /* Late on the 31st in UTC is the previous day in the Americas, so a
         calculation using local date accessors lands in a different month. */
      const before = new Date('2026-03-31T00:30:00.000Z');
      expect(iso(nextOccurrence(before, 'monthly'))).toBe('2026-04-30T00:30:00.000Z');
    });
  });

  describe('independence from the host timezone', () => {
    const originalTimeZone = process.env['TZ'];

    afterEach(() => {
      if (originalTimeZone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTimeZone;
    });

    const ZONES = ['UTC', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata'] as const;

    const CASES: readonly { from: string; rule: RecurrenceRule; expected: string }[] = [
      { from: '2026-03-31T00:30:00.000Z', rule: 'monthly', expected: '2026-04-30T00:30:00.000Z' },
      { from: '2026-01-31T23:45:00.000Z', rule: 'monthly', expected: '2026-02-28T23:45:00.000Z' },
      { from: '2026-03-28T09:00:00.000Z', rule: 'daily', expected: '2026-03-29T09:00:00.000Z' },
      { from: '2026-11-01T04:00:00.000Z', rule: 'every:30d', expected: '2026-12-01T04:00:00.000Z' },
    ];

    it('produces the same instant whatever TZ the process is running in', () => {
      /* Guard: if changing TZ had no effect, the assertions below would pass
         vacuously. Prove the runtime is honouring it before relying on it. */
      process.env['TZ'] = 'UTC';
      const utcHour = new Date('2026-07-01T12:00:00.000Z').getHours();
      process.env['TZ'] = 'Asia/Kolkata';
      const kolkataHour = new Date('2026-07-01T12:00:00.000Z').getHours();
      expect(kolkataHour).not.toBe(utcHour);

      for (const zone of ZONES) {
        process.env['TZ'] = zone;
        for (const testCase of CASES) {
          expect(
            iso(nextOccurrence(new Date(testCase.from), testCase.rule)),
            `${testCase.rule} from ${testCase.from} under TZ=${zone}`,
          ).toBe(testCase.expected);
        }
      }
    });
  });
});
