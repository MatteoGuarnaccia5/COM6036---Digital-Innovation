/**
 * Demonstration script: make a reminder fire on the next tick.
 *
 *   docker compose exec scheduler node apps/scheduler/dist/trigger-reminder.js
 *   docker compose exec scheduler node apps/scheduler/dist/trigger-reminder.js "pay rent"
 *
 * It exists only so that reminder delivery can be shown without waiting for a
 * real deadline. It moves one undelivered reminder's firing time into the past
 * and stops there: the scheduler still claims it, delivers it and stamps
 * `sent_at` through the ordinary path. Nothing here sends an email or marks
 * anything delivered, which is the point - what you watch afterwards in
 * `docker compose logs -f scheduler` is the real mechanism, not a simulation.
 */
import { createDatabase, createPool, shiftReminderIntoThePast } from '@tasks/data';

import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const titleFragment = process.argv.slice(2).join(' ').trim();

  const pool = createPool(config.databaseUrl);

  try {
    const moved = await shiftReminderIntoThePast(createDatabase(pool), {
      ...(titleFragment === '' ? {} : { titleContains: titleFragment }),
    });

    if (moved === null) {
      console.error(
        titleFragment === ''
          ? 'No undelivered reminders. Create a task with a due date, then try again.'
          : `No undelivered reminder for a task matching "${titleFragment}".`,
      );
      process.exitCode = 1;
      return;
    }

    const waitSeconds = Math.round(config.tickIntervalMs / 1000);
    console.log(
      [
        `Reminder ${moved.reminderId} is now due.`,
        `  Task:      ${moved.taskTitle}`,
        `  Recipient: ${moved.recipientEmail}`,
        `  Was due:   ${moved.previousFireAt.toISOString()}`,
        `  Now due:   ${moved.newFireAt.toISOString()}`,
        '',
        `The scheduler will deliver it within ${String(waitSeconds)}s. Watch it happen:`,
        '  docker compose logs -f scheduler',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('trigger-reminder failed', error);
  process.exit(1);
});
