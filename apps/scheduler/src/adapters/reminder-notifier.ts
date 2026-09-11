/**
 * Delivery adapters for the {@link ReminderNotifier} port.
 *
 * Two implementations, chosen by whether SMTP_HOST is set:
 *
 *  - **SMTP** - nodemailer, for a real deployment.
 *  - **stdout** - prints the complete message, recipient, subject and body, so
 *    that `docker compose up` on a clean machine demonstrates working reminder
 *    delivery with no credentials and no mail server. It is a genuine
 *    implementation of the port, not a stub: the scheduler's claim, delivery
 *    and stamping logic runs identically either way, and only the last step
 *    differs.
 *
 * Both signal failure by throwing, which the tick records as an attempt.
 */
import type { DueReminder, ReminderNotifier } from '@tasks/core';
import nodemailer from 'nodemailer';

import { renderReminderEmail } from '../presentation/reminder-email.js';
import type { SchedulerConfig, SmtpSettings } from '../config.js';

const RULE = '─'.repeat(68);

export function createStdoutNotifier(mailFrom: string): ReminderNotifier {
  return {
    async notify(reminder: DueReminder): Promise<void> {
      const email = renderReminderEmail(reminder);

      /* Written as one string so that concurrent writes cannot interleave
         halfway through a message. */
      process.stdout.write(
        [
          RULE,
          'REMINDER EMAIL — printed because SMTP_HOST is not configured',
          RULE,
          `From:    ${mailFrom}`,
          `To:      ${email.to}`,
          `Subject: ${email.subject}`,
          RULE,
          email.text,
          RULE,
          '',
        ].join('\n'),
      );
    },
  };
}

export function createSmtpNotifier(smtp: SmtpSettings, mailFrom: string): ReminderNotifier {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.auth === null ? {} : { auth: smtp.auth }),
  });

  return {
    async notify(reminder: DueReminder): Promise<void> {
      const email = renderReminderEmail(reminder);
      await transport.sendMail({
        from: mailFrom,
        to: email.to,
        subject: email.subject,
        text: email.text,
      });
    },
  };
}

export function createReminderNotifier(config: SchedulerConfig): ReminderNotifier {
  return config.smtp === null
    ? createStdoutNotifier(config.mailFrom)
    : createSmtpNotifier(config.smtp, config.mailFrom);
}
