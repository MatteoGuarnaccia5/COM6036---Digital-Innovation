/**
 * One suite, two implementations.
 *
 * The unit tests for business logic run against in-memory fakes, which is only
 * sound if the fakes behave like the real thing. This suite is the guarantee:
 * it is executed twice, once against the in-memory repositories and once
 * against the Drizzle repositories on a real Postgres server. A behaviour that
 * drifts apart - ordering, partial-update semantics, ownership scoping - fails
 * the build rather than quietly invalidating the unit suite.
 */
import { EmailAlreadyRegisteredError, type NewTask, type Repositories } from '@tasks/core';
import { beforeEach, describe, expect, it } from 'vitest';

const HOUR_MS = 60 * 60 * 1000;

const newTask = (userId: string, overrides: Partial<NewTask> = {}): NewTask => ({
  userId,
  title: 'Write the report',
  description: null,
  dueAt: null,
  priority: 'medium',
  recurrence: null,
  parentTaskId: null,
  reminderOffsetMinutes: 60,
  ...overrides,
});

export function describeRepositoryContract(
  name: string,
  createSubject: () => Promise<Repositories>,
): void {
  describe(`repository contract: ${name}`, () => {
    let repositories: Repositories;
    let ownerId: string;
    let strangerId: string;

    beforeEach(async () => {
      repositories = await createSubject();
      const owner = await repositories.users.create({
        email: 'owner@example.com',
        passwordHash: 'hash-a',
        timezone: 'Europe/London',
      });
      const stranger = await repositories.users.create({
        email: 'stranger@example.com',
        passwordHash: 'hash-b',
        timezone: 'America/New_York',
      });
      ownerId = owner.id;
      strangerId = stranger.id;
    });

    describe('users', () => {
      it('stores the address lowercased and finds it case-insensitively', async () => {
        const created = await repositories.users.create({
          email: '  Mixed.Case@Example.COM ',
          passwordHash: 'hash',
          timezone: 'Europe/London',
        });

        expect(created.email).toBe('mixed.case@example.com');
        await expect(repositories.users.findByEmail('MIXED.CASE@example.com')).resolves.toMatchObject(
          { id: created.id },
        );
      });

      it('reports a duplicate address as a domain error, whatever the case', async () => {
        await expect(
          repositories.users.create({
            email: 'OWNER@example.com',
            passwordHash: 'hash',
            timezone: 'Europe/London',
          }),
        ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
      });

      it('returns null for an unknown id', async () => {
        await expect(
          repositories.users.findById('00000000-0000-0000-0000-000000000000'),
        ).resolves.toBeNull();
      });
    });

    describe('tasks', () => {
      it('creates a task open and uncompleted', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));

        expect(task.status).toBe('open');
        expect(task.completedAt).toBeNull();
        expect(task.userId).toBe(ownerId);
      });

      it('hides another user’s task rather than reporting it exists', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));

        await expect(
          repositories.tasks.findByIdForUser(task.id, strangerId),
        ).resolves.toBeNull();
        await expect(repositories.tasks.update(task.id, strangerId, { title: 'x' })).resolves.toBeNull();
        await expect(repositories.tasks.delete(task.id, strangerId)).resolves.toBe(false);

        /* And the task is untouched. */
        await expect(repositories.tasks.findByIdForUser(task.id, ownerId)).resolves.toMatchObject({
          title: 'Write the report',
        });
      });

      it('orders by deadline with undated tasks last', async () => {
        const base = new Date('2026-05-01T09:00:00.000Z');
        await repositories.tasks.create(newTask(ownerId, { title: 'undated', dueAt: null }));
        await repositories.tasks.create(
          newTask(ownerId, { title: 'later', dueAt: new Date(base.getTime() + 48 * HOUR_MS) }),
        );
        await repositories.tasks.create(newTask(ownerId, { title: 'sooner', dueAt: base }));

        const listed = await repositories.tasks.listForUser(ownerId);
        expect(listed.map((task) => task.title)).toEqual(['sooner', 'later', 'undated']);
      });

      it('lists only the requesting user’s tasks', async () => {
        await repositories.tasks.create(newTask(ownerId, { title: 'mine' }));
        await repositories.tasks.create(newTask(strangerId, { title: 'theirs' }));

        const listed = await repositories.tasks.listForUser(ownerId);
        expect(listed.map((task) => task.title)).toEqual(['mine']);
      });

      it('leaves absent fields alone and clears fields set to null', async () => {
        const task = await repositories.tasks.create(
          newTask(ownerId, {
            description: 'original',
            dueAt: new Date('2026-05-01T09:00:00.000Z'),
            priority: 'high',
          }),
        );

        const afterPartial = await repositories.tasks.update(task.id, ownerId, {
          title: 'renamed',
        });
        expect(afterPartial).toMatchObject({
          title: 'renamed',
          description: 'original',
          priority: 'high',
        });
        expect(afterPartial?.dueAt).toEqual(new Date('2026-05-01T09:00:00.000Z'));

        const afterClear = await repositories.tasks.update(task.id, ownerId, {
          description: null,
          dueAt: null,
        });
        expect(afterClear?.description).toBeNull();
        expect(afterClear?.dueAt).toBeNull();
      });

      it('round-trips every recurrence form', async () => {
        for (const recurrence of ['daily', 'weekly', 'monthly', 'every:14d'] as const) {
          const task = await repositories.tasks.create(newTask(ownerId, { recurrence }));
          const reloaded = await repositories.tasks.findByIdForUser(task.id, ownerId);
          expect(reloaded?.recurrence).toBe(recurrence);
        }
      });

      it('removes a task’s reminders along with the task', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        await repositories.reminders.create({ taskId: task.id, fireAt: new Date() });

        await repositories.tasks.delete(task.id, ownerId);

        await expect(repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
      });
    });

    describe('reminders', () => {
      const past = new Date('2026-05-01T09:00:00.000Z');
      const future = new Date('2026-05-01T11:00:00.000Z');
      const now = new Date('2026-05-01T10:00:00.000Z');

      it('finds the outstanding reminder for a task', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const created = await repositories.reminders.create({ taskId: task.id, fireAt: future });

        const found = await repositories.reminders.findPendingForTask(task.id);
        expect(found).toMatchObject({ id: created.id, attempts: 0, sentAt: null });
        expect(found?.fireAt).toEqual(future);
      });

      it('moves an outstanding reminder but never a delivered one', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const reminder = await repositories.reminders.create({ taskId: task.id, fireAt: future });

        await repositories.reminders.updateFireTime(reminder.id, past);
        expect((await repositories.reminders.findPendingForTask(task.id))?.fireAt).toEqual(past);

        await repositories.reminders.markSent(reminder.id, now);
        await repositories.reminders.updateFireTime(reminder.id, future);
        /* Delivered, so it is no longer pending and was not moved. */
        await expect(repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
      });

      it('deletes only undelivered reminders', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const delivered = await repositories.reminders.create({ taskId: task.id, fireAt: past });
        await repositories.reminders.markSent(delivered.id, now);
        await repositories.reminders.create({ taskId: task.id, fireAt: future });

        await expect(repositories.reminders.deletePendingForTask(task.id)).resolves.toBe(1);
        await expect(repositories.reminders.findPendingForTask(task.id)).resolves.toBeNull();
      });

      it('claims only reminders that are due, undelivered and not exhausted', async () => {
        const task = await repositories.tasks.create(newTask(ownerId, { title: 'Pay rent' }));

        const due = await repositories.reminders.create({ taskId: task.id, fireAt: past });
        const notYetDue = await repositories.reminders.create({ taskId: task.id, fireAt: future });
        const exhausted = await repositories.reminders.create({ taskId: task.id, fireAt: past });
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await repositories.reminders.recordFailure(exhausted.id, 'smtp unavailable');
        }

        const claimed = await repositories.reminders.claimDue({ now, limit: 50, maxAttempts: 5 });

        expect(claimed.map((item) => item.reminderId)).toEqual([due.id]);
        expect(claimed.map((item) => item.reminderId)).not.toContain(notYetDue.id);
        expect(claimed[0]).toMatchObject({
          task: { title: 'Pay rent', priority: 'medium' },
          recipient: { email: 'owner@example.com', timezone: 'Europe/London' },
        });
      });

      it('returns instants as Date objects, not as whatever the driver produced', async () => {
        /*
         * Added after a real defect. The SQL implementation claims reminders
         * with a raw query, which bypasses the ORM's column mapping and hands
         * timestamps back as strings; the in-memory fake returned Dates. Both
         * satisfied the TypeScript signature, so nothing failed until the
         * scheduler tried to format one and threw "Invalid time value" at
         * delivery time.
         *
         * Asserting the runtime type - not just the shape - is what makes this
         * contract worth having.
         */
        const task = await repositories.tasks.create(
          newTask(ownerId, { dueAt: new Date('2026-05-01T12:00:00.000Z') }),
        );
        await repositories.reminders.create({ taskId: task.id, fireAt: past });

        const [claimed] = await repositories.reminders.claimDue({
          now,
          limit: 1,
          maxAttempts: 5,
        });

        expect(claimed?.fireAt).toBeInstanceOf(Date);
        expect(claimed?.fireAt.toISOString()).toBe(past.toISOString());
        expect(claimed?.task.dueAt).toBeInstanceOf(Date);
        expect(claimed?.task.dueAt?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
      });

      it('honours the claim limit, soonest first', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const earliest = await repositories.reminders.create({
          taskId: task.id,
          fireAt: new Date(past.getTime() - HOUR_MS),
        });
        await repositories.reminders.create({ taskId: task.id, fireAt: past });

        const claimed = await repositories.reminders.claimDue({ now, limit: 1, maxAttempts: 5 });
        expect(claimed.map((item) => item.reminderId)).toEqual([earliest.id]);
      });

      it('stamps delivery once and ignores a second stamp', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const reminder = await repositories.reminders.create({ taskId: task.id, fireAt: past });

        await repositories.reminders.markSent(reminder.id, now);
        await repositories.reminders.markSent(reminder.id, new Date(now.getTime() + HOUR_MS));

        const claimed = await repositories.reminders.claimDue({ now, limit: 50, maxAttempts: 5 });
        expect(claimed).toEqual([]);
      });

      it('counts failures and keeps the reason, leaving the reminder unsent', async () => {
        const task = await repositories.tasks.create(newTask(ownerId));
        const reminder = await repositories.reminders.create({ taskId: task.id, fireAt: past });

        await repositories.reminders.recordFailure(reminder.id, 'connection refused');
        await repositories.reminders.recordFailure(reminder.id, 'mailbox full');

        const pending = await repositories.reminders.findPendingForTask(task.id);
        expect(pending).toMatchObject({
          id: reminder.id,
          attempts: 2,
          lastError: 'mailbox full',
          sentAt: null,
        });
      });
    });
  });
}
