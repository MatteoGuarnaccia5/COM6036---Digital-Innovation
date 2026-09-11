/**
 * Business rules about what makes a task well-formed.
 *
 * This is not input parsing. Deciding that a JSON body has a string where a
 * string belongs, and turning a user's local date into a UTC instant, are the
 * presentation layer's job. What lives here are the rules that would still hold
 * if the application had no HTTP interface at all.
 */
import { ValidationError } from '../domain/errors.js';
import type { RecurrenceRule, TaskPriority } from '../domain/types.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
/** Four weeks. Long enough to be useful, short enough to catch a units mistake. */
export const MAX_REMINDER_OFFSET_MINUTES = 40_320;
export const DEFAULT_REMINDER_OFFSET_MINUTES = 60;

/** The attributes of a task, once merged with any existing state. */
export interface TaskAttributes {
  readonly title: string;
  readonly description: string | null;
  /** The task's deadline, in UTC. */
  readonly dueAt: Date | null;
  readonly priority: TaskPriority;
  readonly recurrence: RecurrenceRule | null;
  readonly reminderOffsetMinutes: number;
}

export function validateTaskAttributes(attributes: TaskAttributes): void {
  const title = attributes.title.trim();
  if (title.length === 0) {
    throw new ValidationError('A task needs a title', 'title');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`A title may be at most ${MAX_TITLE_LENGTH} characters`, 'title');
  }

  if (attributes.description !== null && attributes.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `A description may be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      'description',
    );
  }

  if (attributes.dueAt !== null && Number.isNaN(attributes.dueAt.getTime())) {
    throw new ValidationError('The due date is not a valid date', 'dueAt');
  }

  const offset = attributes.reminderOffsetMinutes;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_REMINDER_OFFSET_MINUTES) {
    throw new ValidationError(
      `The reminder offset must be a whole number of minutes between 0 and ${MAX_REMINDER_OFFSET_MINUTES}`,
      'reminderOffsetMinutes',
    );
  }

  /*
   * A recurrence rule advances a deadline, so a recurring task without one has
   * nothing to advance and would generate an endless series of undated clones.
   * The specification leaves both columns independently nullable; rejecting the
   * combination is a decision taken here and recorded in docs/build-log.md.
   */
  if (attributes.recurrence !== null && attributes.dueAt === null) {
    throw new ValidationError('A recurring task needs a due date', 'recurrence');
  }
}

/** Titles are stored trimmed; a description that is blank is stored as null. */
export function normaliseTaskAttributes(attributes: TaskAttributes): TaskAttributes {
  const description = attributes.description?.trim() ?? null;
  return {
    ...attributes,
    title: attributes.title.trim(),
    description: description === null || description.length === 0 ? null : description,
  };
}
