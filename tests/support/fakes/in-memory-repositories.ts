/**
 * In-memory implementations of the repository ports.
 *
 * These are what the unit suite runs against: no database, no HTTP, no
 * migrations. They exist so that recurrence arithmetic, reminder policy and
 * task state transitions can be tested at the speed of a function call, which
 * is the practical payoff of business logic depending on interfaces rather than
 * on an ORM.
 *
 * Faithfulness is not assumed. `tests/contract/repositories.test.ts` runs one
 * shared suite against both these fakes and the real Drizzle repositories, so a
 * behaviour that drifts apart fails the build.
 *
 * The one thing they cannot reproduce is concurrency: `FOR UPDATE SKIP LOCKED`
 * has no meaning without a second connection. Locking behaviour is therefore
 * proven only against Postgres, in the scheduler suite.
 */
import { randomUUID } from 'node:crypto';

import { EmailAlreadyRegisteredError } from '@tasks/core';
import type {
  ClaimDueRemindersInput,
  Clock,
  DueReminder,
  NewReminder,
  NewTask,
  NewUser,
  Reminder,
  Repositories,
  ReminderRepository,
  Task,
  TaskChanges,
  TaskRepository,
  UnitOfWork,
  User,
  UserRepository,
} from '@tasks/core';

interface Store {
  users: Map<string, User>;
  tasks: Map<string, Task>;
  reminders: Map<string, Reminder>;
}

const emptyStore = (): Store => ({ users: new Map(), tasks: new Map(), reminders: new Map() });

const cloneStore = (store: Store): Store => ({
  users: new Map(store.users),
  tasks: new Map(store.tasks),
  reminders: new Map(store.reminders),
});

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** Mirrors `due_at ASC NULLS LAST, created_at ASC` from the SQL implementation. */
function byDueDateThenCreation(a: Task, b: Task): number {
  if (a.dueAt === null && b.dueAt !== null) return 1;
  if (a.dueAt !== null && b.dueAt === null) return -1;
  if (a.dueAt !== null && b.dueAt !== null && a.dueAt.getTime() !== b.dueAt.getTime()) {
    return a.dueAt.getTime() - b.dueAt.getTime();
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export interface InMemoryBackend {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  /** Direct access for arranging fixtures and asserting outcomes. */
  readonly store: Store;
}

export function createInMemoryBackend(clock?: Clock): InMemoryBackend {
  let store = emptyStore();
  const now = (): Date => clock?.now() ?? new Date();

  const users: UserRepository = {
    async findById(userId) {
      return store.users.get(userId) ?? null;
    },
    async findByEmail(email) {
      const wanted = normaliseEmail(email);
      return [...store.users.values()].find((user) => user.email === wanted) ?? null;
    },
    async create(input: NewUser): Promise<User> {
      const email = normaliseEmail(input.email);
      if ([...store.users.values()].some((user) => user.email === email)) {
        throw new EmailAlreadyRegisteredError();
      }
      const user: User = {
        id: randomUUID(),
        email,
        passwordHash: input.passwordHash,
        timezone: input.timezone,
        createdAt: now(),
      };
      store.users.set(user.id, user);
      return user;
    },
  };

  const tasks: TaskRepository = {
    async findByIdForUser(taskId, userId) {
      const task = store.tasks.get(taskId);
      return task !== undefined && task.userId === userId ? task : null;
    },
    async listForUser(userId) {
      return [...store.tasks.values()]
        .filter((task) => task.userId === userId)
        .sort(byDueDateThenCreation);
    },
    async create(input: NewTask): Promise<Task> {
      const task: Task = {
        id: randomUUID(),
        userId: input.userId,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        priority: input.priority,
        status: 'open',
        recurrence: input.recurrence,
        parentTaskId: input.parentTaskId,
        reminderOffsetMinutes: input.reminderOffsetMinutes,
        createdAt: now(),
        completedAt: null,
      };
      store.tasks.set(task.id, task);
      return task;
    },
    async update(taskId, userId, changes: TaskChanges): Promise<Task | null> {
      const existing = store.tasks.get(taskId);
      if (existing === undefined || existing.userId !== userId) return null;

      const updated: Task = {
        ...existing,
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.dueAt !== undefined ? { dueAt: changes.dueAt } : {}),
        ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
        ...(changes.recurrence !== undefined ? { recurrence: changes.recurrence } : {}),
        ...(changes.reminderOffsetMinutes !== undefined
          ? { reminderOffsetMinutes: changes.reminderOffsetMinutes }
          : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.completedAt !== undefined ? { completedAt: changes.completedAt } : {}),
      };
      store.tasks.set(taskId, updated);
      return updated;
    },
    async delete(taskId, userId) {
      const existing = store.tasks.get(taskId);
      if (existing === undefined || existing.userId !== userId) return false;

      /* Matches ON DELETE CASCADE on reminders.task_id. */
      for (const [id, reminder] of store.reminders) {
        if (reminder.taskId === taskId) store.reminders.delete(id);
      }
      store.tasks.delete(taskId);
      return true;
    },
  };

  const reminders: ReminderRepository = {
    async findPendingForTask(taskId) {
      return (
        [...store.reminders.values()]
          .filter((reminder) => reminder.taskId === taskId && reminder.sentAt === null)
          .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())[0] ?? null
      );
    },
    async create(input: NewReminder): Promise<Reminder> {
      const reminder: Reminder = {
        id: randomUUID(),
        taskId: input.taskId,
        fireAt: input.fireAt,
        sentAt: null,
        attempts: 0,
        lastError: null,
        createdAt: now(),
      };
      store.reminders.set(reminder.id, reminder);
      return reminder;
    },
    async updateFireTime(reminderId, fireAt) {
      const existing = store.reminders.get(reminderId);
      if (existing === undefined || existing.sentAt !== null) return;
      store.reminders.set(reminderId, { ...existing, fireAt });
    },
    async deletePendingForTask(taskId) {
      let removed = 0;
      for (const [id, reminder] of store.reminders) {
        if (reminder.taskId === taskId && reminder.sentAt === null) {
          store.reminders.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    async claimDue(input: ClaimDueRemindersInput): Promise<DueReminder[]> {
      return [...store.reminders.values()]
        .filter(
          (reminder) =>
            reminder.sentAt === null &&
            reminder.fireAt.getTime() <= input.now.getTime() &&
            reminder.attempts < input.maxAttempts,
        )
        .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
        .slice(0, input.limit)
        .flatMap((reminder) => {
          const task = store.tasks.get(reminder.taskId);
          if (task === undefined) return [];
          const recipient = store.users.get(task.userId);
          if (recipient === undefined) return [];

          return [
            {
              reminderId: reminder.id,
              fireAt: reminder.fireAt,
              attempts: reminder.attempts,
              task: {
                id: task.id,
                title: task.title,
                description: task.description,
                dueAt: task.dueAt,
                priority: task.priority,
              },
              recipient: { email: recipient.email, timezone: recipient.timezone },
            },
          ];
        });
    },
    async markSent(reminderId, sentAt) {
      const existing = store.reminders.get(reminderId);
      if (existing === undefined || existing.sentAt !== null) return;
      store.reminders.set(reminderId, { ...existing, sentAt });
    },
    async recordFailure(reminderId, error) {
      const existing = store.reminders.get(reminderId);
      if (existing === undefined) return;
      store.reminders.set(reminderId, {
        ...existing,
        attempts: existing.attempts + 1,
        lastError: error.slice(0, 1000),
      });
    },
  };

  const repositories: Repositories = { users, tasks, reminders };

  const unitOfWork: UnitOfWork = {
    async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
      /* Snapshot and restore stands in for BEGIN/ROLLBACK, so a unit test can
         assert that a failed operation leaves nothing behind. */
      const snapshot = cloneStore(store);
      try {
        return await work(repositories);
      } catch (error) {
        store = snapshot;
        throw error;
      }
    },
  };

  return {
    repositories,
    unitOfWork,
    get store() {
      return store;
    },
  };
}
