/**
 * The reminder scheduler.
 *
 * A separate process in its own container, sharing the business logic and data
 * access layers with the web application and nothing else. It has no HTTP
 * client, no knowledge of the web app's address, and no way to call its API: it
 * reads and writes the database through the same repositories, which is what
 * makes the two lifecycles independent. Restarting or rebuilding either leaves
 * the other running.
 *
 * The process itself is deliberately thin. It owns a timer, a database pool and
 * a mail transport; the rules about which reminders are due, how failures are
 * counted and when to give up all live in `@tasks/core`, where they can be
 * tested without a scheduler running at all.
 *
 * ## The loop
 *
 * Ticks are scheduled one after another rather than on a fixed interval: the
 * next wait begins when the previous tick finishes. With `setInterval`, a tick
 * that outran its period - a slow SMTP server, a long batch - would overlap the
 * next one. That would still be *correct*, because `SKIP LOCKED` means two
 * overlapping ticks divide the work rather than duplicate it, but it would pile
 * up connections under exactly the conditions where the database is already
 * struggling.
 *
 * A tick runs immediately on start, before the first wait, so a scheduler that
 * has been down delivers its backlog straight away instead of a minute later.
 */
import { runReminderTick } from '@tasks/core';
import { createDatabase, createPool, createUnitOfWork, runMigrations } from '@tasks/data';

import { createReminderNotifier } from './adapters/reminder-notifier.js';
import { systemClock } from './adapters/system-clock.js';
import { loadConfig } from './config.js';

/** A wait that can be cut short, so shutdown does not take up to a minute. */
function interruptibleSleep(milliseconds: number): { promise: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    cancel = (): void => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);

  /* Applied here as well as in the web process, guarded by the same advisory
     lock. Neither process waits for the other to have started. */
  console.log('[scheduler] applying migrations');
  await runMigrations(pool);

  const unitOfWork = createUnitOfWork(createDatabase(pool));
  const notifier = createReminderNotifier(config);

  console.log(
    config.smtp === null
      ? '[scheduler] no SMTP_HOST set — reminders will be printed to this log in full'
      : `[scheduler] sending mail via ${config.smtp.host}:${String(config.smtp.port)}`,
  );
  console.log(
    `[scheduler] ticking every ${String(config.tickIntervalMs / 1000)}s, ` +
      `up to ${String(config.batchLimit)} reminders per tick, ` +
      `giving up after ${String(config.maxAttempts)} attempts`,
  );

  let stopping = false;
  let currentSleep: { promise: Promise<void>; cancel: () => void } | null = null;
  let quietTicks = 0;

  const tick = async (): Promise<void> => {
    const result = await runReminderTick({
      unitOfWork,
      notifier,
      clock: systemClock,
      batchLimit: config.batchLimit,
      maxAttempts: config.maxAttempts,
    });

    if (result.claimed === 0) {
      /* Silence would be indistinguishable from a stalled process, so a
         heartbeat is logged occasionally. */
      quietTicks += 1;
      if (quietTicks % 10 === 1) {
        console.log(`[scheduler] nothing due (${String(quietTicks)} quiet ticks)`);
      }
      return;
    }

    quietTicks = 0;
    console.log(
      `[scheduler] claimed ${String(result.claimed)}, ` +
        `delivered ${String(result.delivered)}, failed ${String(result.failed)}`,
    );
  };

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[scheduler] ${signal} received, finishing the current tick`);
    currentSleep?.cancel();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      /* A tick that fails outright - the database is down, say - must not kill
         the process. The next one will try again. */
      console.error('[scheduler] tick failed', error);
    }

    if (stopping) break;

    currentSleep = interruptibleSleep(config.tickIntervalMs);
    await currentSleep.promise;
    currentSleep = null;
  }

  await pool.end();
  console.log('[scheduler] stopped');
}

main().catch((error: unknown) => {
  console.error('[scheduler] failed to start', error);
  process.exit(1);
});
