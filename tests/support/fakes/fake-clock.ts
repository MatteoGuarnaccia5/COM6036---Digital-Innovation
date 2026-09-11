import type { Clock } from '@tasks/core';

/**
 * A clock the test controls.
 *
 * Business logic takes the current instant as an input rather than reading it
 * from the system, which is what makes "a reminder came due while the scheduler
 * was down" an ordinary test case instead of an exercise in waiting.
 */
export interface FakeClock extends Clock {
  set(instant: Date): void;
  advance(milliseconds: number): void;
}

export function createFakeClock(start: Date): FakeClock {
  let current = new Date(start.getTime());

  return {
    now: (): Date => new Date(current.getTime()),
    set(instant: Date): void {
      current = new Date(instant.getTime());
    },
    advance(milliseconds: number): void {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}
