/**
 * The scheduler's presentation layer.
 *
 * The point of these tests is the boundary, not the prose: a reminder for a
 * London account and one for a New York account describe the *same instant*
 * with different wall-clock times, because formatting is the only place a
 * timezone is applied. Nothing beneath this layer was told which zone to use.
 */
import type { DueReminder } from '@tasks/core';
import { createStdoutNotifier } from '@tasks/scheduler/adapters/reminder-notifier';
import { renderReminderEmail } from '@tasks/scheduler/presentation/reminder-email';
import { describe, expect, it } from 'vitest';

const dueReminder = (overrides: {
  timezone?: string;
  description?: string | null;
  dueAt?: Date | null;
  priority?: DueReminder['task']['priority'];
} = {}): DueReminder => ({
  reminderId: '11111111-1111-1111-1111-111111111111',
  fireAt: new Date('2026-07-01T12:00:00.000Z'),
  attempts: 0,
  task: {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'Submit the literature review',
    description: overrides.description === undefined ? 'Second draft, 2,000 words.' : overrides.description,
    dueAt: overrides.dueAt === undefined ? new Date('2026-07-01T13:00:00.000Z') : overrides.dueAt,
    priority: overrides.priority ?? 'high',
  },
  recipient: {
    email: 'demo@example.com',
    timezone: overrides.timezone ?? 'Europe/London',
  },
});

describe('renderReminderEmail', () => {
  it('addresses the recipient and names the task in the subject', () => {
    const email = renderReminderEmail(dueReminder());

    expect(email.to).toBe('demo@example.com');
    expect(email.subject).toBe('Reminder: Submit the literature review');
  });

  it('states the deadline in the recipient’s timezone', () => {
    /* 13:00 UTC on 1 July is 14:00 in London (BST) and 09:00 in New York. */
    const london = renderReminderEmail(dueReminder({ timezone: 'Europe/London' }));
    const newYork = renderReminderEmail(dueReminder({ timezone: 'America/New_York' }));

    expect(london.text).toContain('14:00');
    expect(london.text).toContain('(Europe/London)');
    expect(newYork.text).toContain('09:00');
    expect(newYork.text).toContain('(America/New_York)');

    /* Same instant, two renderings - the conversion is the only difference. */
    expect(london.text).not.toBe(newYork.text);
  });

  it('includes the description and priority, and omits an absent description', () => {
    const withDescription = renderReminderEmail(dueReminder());
    expect(withDescription.text).toContain('Second draft, 2,000 words.');
    expect(withDescription.text).toContain('Priority: High');

    const withoutDescription = renderReminderEmail(dueReminder({ description: null }));
    expect(withoutDescription.text).toContain('Priority: High');
    expect(withoutDescription.text).not.toContain('Second draft');
  });

  it('says something sensible when a task has no deadline', () => {
    const email = renderReminderEmail(dueReminder({ dueAt: null }));

    expect(email.text).toContain('No deadline recorded');
    expect(email.text).not.toContain('null');
  });
});

describe('the stdout notifier', () => {
  /** Captures what the notifier writes, so the fallback path can be asserted. */
  async function capture(reminder: DueReminder): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.stdout.write has three overloads; matching them exactly here adds nothing.
    process.stdout.write = ((chunk: any): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await createStdoutNotifier('tasks@localhost').notify(reminder);
    } finally {
      process.stdout.write = original;
    }

    return chunks.join('');
  }

  it('prints the complete message: sender, recipient, subject and body', async () => {
    const printed = await capture(dueReminder());

    expect(printed).toContain('From:    tasks@localhost');
    expect(printed).toContain('To:      demo@example.com');
    expect(printed).toContain('Subject: Reminder: Submit the literature review');
    expect(printed).toContain('Second draft, 2,000 words.');
    /* States why it went to the log rather than to a mail server. */
    expect(printed).toContain('SMTP_HOST is not configured');
  });

  it('writes each message as a single call, so concurrent deliveries cannot interleave', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above.
    process.stdout.write = ((chunk: any): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const notifier = createStdoutNotifier('tasks@localhost');
      await Promise.all([notifier.notify(dueReminder()), notifier.notify(dueReminder())]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks).toHaveLength(2);
  });
});
