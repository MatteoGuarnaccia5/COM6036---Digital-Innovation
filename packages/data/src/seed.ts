/**
 * Demo seed data.
 *
 * Runs on first start so that `docker compose up` produces a populated
 * interface with no manual steps. It is idempotent by the simplest possible
 * rule: if the database already has a user, it does nothing. A restart, a
 * rebuild, or both containers racing each other therefore cannot duplicate it.
 *
 * The password hash is supplied by the caller. Hashing is a policy decision
 * that belongs to the composition root, and it keeps bcrypt - a native module
 * - out of the data access layer's dependencies.
 */
import { randomUUID } from 'node:crypto';

import { computeReminderFireTime } from '@tasks/core';

import type { Database } from './client.js';
import { reminders, tasks, users } from './schema.js';

export const DEMO_EMAIL = 'demo@example.com';
/**
 * The demo account's password, in plain text and on purpose: it is printed in
 * the README so a marker can sign in immediately. It is a fixture, never a
 * default for a real account, and the seed only runs against an empty database.
 */
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_TIMEZONE = 'Europe/London';

export interface SeedOptions {
  /** bcrypt hash of the documented demo password. */
  readonly passwordHash: string;
  /** Injected so seeded data is positioned relative to a known instant. */
  readonly now?: Date;
}

export interface SeedResult {
  readonly seeded: boolean;
  readonly userId: string | null;
  readonly taskCount: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type TaskSeed = Omit<typeof tasks.$inferInsert, 'userId'>;

function buildTasks(userId: string, now: Date): (typeof tasks.$inferInsert)[] {
  /*
   * Offsets are measured from the top of the current hour rather than from the
   * exact moment of seeding, so demo deadlines land on clean times like 17:00
   * instead of whatever minute the container happened to start at. Purely
   * cosmetic - the seeded data is for screenshots as much as for exercising the
   * application.
   */
  const anchor = new Date(now);
  anchor.setUTCMinutes(0, 0, 0);
  const at = (offsetMs: number): Date => new Date(anchor.getTime() + offsetMs);

  /* A completed occurrence and the open occurrence it generated, so the
     parent_task_id linkage from FR3 is visible in the seeded data. */
  const standupParentId = randomUUID();

  const seeds: TaskSeed[] = [
    {
      title: 'Submit COM6036 literature review',
      description: 'Second draft, 2,000 words, upload to the module page.',
      dueAt: at(-3 * DAY_MS),
      priority: 'high',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 120,
      completedAt: null,
    },
    {
      title: 'Renew library books',
      description: null,
      dueAt: at(-1 * DAY_MS),
      priority: 'low',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Reply to supervisor about ethics form',
      description: 'She asked for the revised participant consent wording.',
      dueAt: at(-6 * HOUR_MS),
      priority: 'medium',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Prepare sprint demo slides',
      description: 'Five slides: scope, architecture, scheduler, tests, demo.',
      dueAt: at(4 * HOUR_MS),
      priority: 'high',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      id: standupParentId,
      title: 'Write stand-up notes',
      description: 'Yesterday, today, blockers.',
      dueAt: at(-1 * DAY_MS + 2 * HOUR_MS),
      priority: 'medium',
      status: 'done',
      recurrence: 'daily',
      parentTaskId: null,
      reminderOffsetMinutes: 15,
      completedAt: at(-1 * DAY_MS + 3 * HOUR_MS),
    },
    {
      title: 'Write stand-up notes',
      description: 'Yesterday, today, blockers.',
      dueAt: at(2 * HOUR_MS),
      priority: 'medium',
      status: 'open',
      recurrence: 'daily',
      parentTaskId: standupParentId,
      reminderOffsetMinutes: 15,
      completedAt: null,
    },
    {
      title: 'Weekly project status report',
      description: 'Send to the supervisor before Friday close of play.',
      dueAt: at(3 * DAY_MS),
      priority: 'medium',
      status: 'open',
      recurrence: 'weekly',
      parentTaskId: null,
      reminderOffsetMinutes: 180,
      completedAt: null,
    },
    {
      title: 'Pay rent',
      description: null,
      dueAt: at(8 * DAY_MS),
      priority: 'high',
      status: 'open',
      recurrence: 'monthly',
      parentTaskId: null,
      reminderOffsetMinutes: 1440,
      completedAt: null,
    },
    {
      title: 'Back up laptop to external drive',
      description: null,
      dueAt: at(5 * DAY_MS),
      priority: 'low',
      status: 'open',
      recurrence: 'every:14d',
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Review pull request #42',
      description: 'Repository interfaces and the in-memory fakes.',
      dueAt: at(2 * DAY_MS),
      priority: 'medium',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Draft ethics approval form',
      description: 'Section 4 needs the data retention period.',
      dueAt: at(6 * DAY_MS),
      priority: 'high',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 240,
      completedAt: null,
    },
    {
      title: 'Book dentist appointment',
      description: null,
      dueAt: at(12 * DAY_MS),
      priority: 'low',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Order a replacement keyboard',
      description: 'The B key sticks.',
      dueAt: null,
      priority: 'low',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Read Kleppmann chapter 7 - Transactions',
      description: 'Background reading for the scheduler write-up.',
      dueAt: null,
      priority: 'medium',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    },
    {
      title: 'Set up the CI pipeline',
      description: 'Lint, typecheck and tests on push, with a Postgres service.',
      dueAt: at(-2 * DAY_MS),
      priority: 'high',
      status: 'done',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: at(-2 * DAY_MS - 3 * HOUR_MS),
    },
    {
      title: 'Write the requirements document',
      description: 'FR1-FR8 with acceptance criteria.',
      dueAt: at(-5 * DAY_MS),
      priority: 'high',
      status: 'done',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: at(-5 * DAY_MS - 1 * HOUR_MS),
    },
    {
      title: 'Chase the room booking for the demo',
      description: null,
      dueAt: at(-4 * HOUR_MS),
      priority: 'medium',
      status: 'done',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: at(-2 * HOUR_MS),
    },
  ];

  return seeds.map((seed) => ({ ...seed, userId }));
}

/**
 * A reminder row for every open task with a deadline.
 *
 * Reminders whose firing time has already passed are seeded as delivered, so a
 * fresh `docker compose up` does not dump a dozen historical reminders to the
 * scheduler's log on its first tick. Use the demo trigger script to make one
 * fire on demand - see the README.
 *
 * The firing time comes from @tasks/core's scheduling policy rather than being
 * recomputed here, so the fixtures cannot disagree with the rule the running
 * application applies.
 */
function buildReminders(
  seededTasks: readonly {
    id: string;
    dueAt: Date | null;
    status: string;
    reminderOffsetMinutes: number;
  }[],
  now: Date,
): (typeof reminders.$inferInsert)[] {
  return seededTasks.flatMap((task) => {
    if (task.status !== 'open' || task.dueAt === null) return [];

    const fireAt = computeReminderFireTime(task.dueAt, task.reminderOffsetMinutes);
    const alreadyPassed = fireAt.getTime() <= now.getTime();

    return [
      {
        taskId: task.id,
        fireAt,
        sentAt: alreadyPassed ? fireAt : null,
        attempts: alreadyPassed ? 1 : 0,
        lastError: null,
      },
    ];
  });
}

export async function seedDemoData(db: Database, options: SeedOptions): Promise<SeedResult> {
  const now = options.now ?? new Date();

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) {
    return { seeded: false, userId: null, taskCount: 0 };
  }

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: DEMO_EMAIL,
        passwordHash: options.passwordHash,
        timezone: DEMO_TIMEZONE,
      })
      .returning({ id: users.id });

    if (user === undefined) throw new Error('seed: failed to insert the demo user');

    const inserted = await tx
      .insert(tasks)
      .values(buildTasks(user.id, now))
      .returning({
        id: tasks.id,
        dueAt: tasks.dueAt,
        status: tasks.status,
        reminderOffsetMinutes: tasks.reminderOffsetMinutes,
      });

    const reminderRows = buildReminders(inserted, now);
    if (reminderRows.length > 0) {
      await tx.insert(reminders).values(reminderRows);
    }

    return { seeded: true, userId: user.id, taskCount: inserted.length };
  });
}
