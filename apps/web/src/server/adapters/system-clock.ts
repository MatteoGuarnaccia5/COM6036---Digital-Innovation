import type { Clock } from '@tasks/core';

/**
 * The real clock, in UTC.
 *
 * `new Date()` appears in the composition root rather than inside business
 * logic so that every rule depending on the current instant can be driven by a
 * test. Each process builds its own adapters; the scheduler has an identical
 * one, which keeps the two composition roots independent of each other.
 */
export const systemClock: Clock = {
  now: (): Date => new Date(),
};
