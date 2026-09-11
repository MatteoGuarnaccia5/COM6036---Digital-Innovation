/**
 * The scheduler's presentation layer.
 *
 * This is the second place in the system where a UTC instant becomes a local
 * time, and it is worth being explicit about why it exists. The web
 * application's presentation layer renders deadlines for a browser; this one
 * renders them for an email. They are two edges of the same architecture, not a
 * duplication: both sit above the business logic, and neither is reachable from
 * it.
 *
 * The business logic decides *that* a reminder should go out and hands over a
 * `DueReminder`. It does not compose a subject line, because writing "due at
 * 09:00" requires knowing the recipient's timezone - and the layer below has no
 * concept of one.
 */
import type { DueReminder } from '@tasks/core';

export interface RenderedEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** e.g. `Tue 8 Sep 2026, 09:00`. */
export function formatInZone(instant: Date, timeZone: string): string {
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

const PRIORITY_WORD: Record<DueReminder['task']['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function renderReminderEmail(reminder: DueReminder): RenderedEmail {
  const { task, recipient } = reminder;

  /* A reminder is only ever scheduled for a task that has a deadline, but the
     type admits null, so say something sensible rather than printing "null". */
  const due =
    task.dueAt === null
      ? 'No deadline recorded'
      : `${formatInZone(task.dueAt, recipient.timezone)} (${recipient.timezone})`;

  const lines = [
    `${task.title}`,
    '',
    `Due: ${due}`,
    `Priority: ${PRIORITY_WORD[task.priority]}`,
  ];

  if (task.description !== null && task.description.trim() !== '') {
    lines.push('', task.description.trim());
  }

  lines.push('', '--', 'Sent by your self-hosted task manager.');

  return {
    to: recipient.email,
    subject: `Reminder: ${task.title}`,
    text: lines.join('\n'),
  };
}
