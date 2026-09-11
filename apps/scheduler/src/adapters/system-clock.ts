import type { Clock } from '@tasks/core';

/**
 * The real clock, in UTC.
 *
 * The scheduler builds its own adapters rather than importing the web app's -
 * which would be an import between two processes that are meant to be
 * independently deployable. Five duplicated lines are a smaller cost than a
 * dependency edge that the architecture says should not exist.
 */
export const systemClock: Clock = {
  now: (): Date => new Date(),
};
