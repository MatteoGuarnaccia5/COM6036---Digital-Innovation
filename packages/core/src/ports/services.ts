/**
 * Service ports - the non-storage things business logic needs from the world.
 *
 * Each is an interface here and an adapter in the process that composes the
 * application: bcrypt and the system clock in `apps/web`, nodemailer and the
 * stdout fallback in `apps/scheduler`. Keeping them as ports is what lets the
 * unit suite run recurrence and scheduling policy with no I/O at all, and what
 * keeps a native module like bcrypt out of this package's dependencies.
 */
import type { DueReminder } from '../domain/types.js';

/**
 * The current instant, in UTC.
 *
 * Injected rather than called directly so that "what time is it" is an input to
 * business logic. Without this, testing a DST boundary or a reminder that came
 * due during downtime would mean manipulating the system clock.
 */
export interface Clock {
  now(): Date;
}

export interface PasswordHasher {
  hash(plainText: string): Promise<string>;
  /** Constant-time comparison; returns false rather than throwing on a bad hash. */
  verify(plainText: string, passwordHash: string): Promise<boolean>;
}

/**
 * Delivers one reminder.
 *
 * The port takes the domain record, not a rendered message, because composing
 * subject and body means formatting a deadline in the recipient's timezone -
 * a presentation concern. The scheduler's own presentation module does that
 * work; business logic only decides *that* a reminder should go out.
 *
 * An implementation signals failure by throwing. The tick records the reason
 * and leaves the reminder unsent for a later attempt.
 */
export interface ReminderNotifier {
  notify(reminder: DueReminder): Promise<void>;
}
