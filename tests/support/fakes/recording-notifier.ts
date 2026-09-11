import type { DueReminder, ReminderNotifier } from '@tasks/core';

/**
 * A notifier that records what it was asked to deliver, and can be told to
 * fail. Standing in for SMTP here is the whole point of the port: the delivery
 * rules can be tested without a mail server, and the exactly-once property is
 * asserted by counting calls.
 */
export interface RecordingNotifier extends ReminderNotifier {
  readonly delivered: DueReminder[];
  /** Reminder ids that should throw instead of delivering. */
  failFor(reminderId: string, message?: string): void;
  failAll(message?: string): void;
  succeedAgain(): void;
}

export function createRecordingNotifier(): RecordingNotifier {
  const delivered: DueReminder[] = [];
  const failing = new Set<string>();
  let failEverything: string | null = null;

  return {
    delivered,
    failFor(reminderId: string): void {
      failing.add(reminderId);
    },
    failAll(message = 'SMTP connection refused'): void {
      failEverything = message;
    },
    succeedAgain(): void {
      failing.clear();
      failEverything = null;
    },
    async notify(reminder: DueReminder): Promise<void> {
      if (failEverything !== null) throw new Error(failEverything);
      if (failing.has(reminder.reminderId)) {
        throw new Error(`delivery failed for ${reminder.reminderId}`);
      }
      delivered.push(reminder);
    },
  };
}
