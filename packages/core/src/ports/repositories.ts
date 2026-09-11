/**
 * Repository ports.
 *
 * These interfaces are the entire contract between business logic and storage.
 * `packages/data` implements them with Drizzle; the test suite implements them
 * in memory. Neither implementation is visible from this package - the
 * composition root injects one - which is what allows `@tasks/core` to declare
 * no runtime dependencies at all.
 *
 * Two things to notice, because they carry design weight:
 *
 *  1. Every task method takes a `userId`. Ownership is a property of the query,
 *     not a check performed afterwards, so a route cannot forget to apply it
 *     and a missing row is indistinguishable from someone else's row.
 *
 *  2. There is no `beginTransaction`. Transaction scope is expressed by
 *     {@link UnitOfWork}, which hands business logic a repository set that
 *     happens to be transactional. Business logic therefore composes atomic
 *     work without knowing that transactions, or SQL, exist.
 */
import type {
  DueReminder,
  NewReminder,
  NewTask,
  NewUser,
  Reminder,
  Task,
  TaskChanges,
  User,
} from '../domain/types.js';

export interface UserRepository {
  findById(userId: string): Promise<User | null>;
  /** Email comparison is case-insensitive; addresses are stored lowercased. */
  findByEmail(email: string): Promise<User | null>;
  /**
   * Throws `EmailAlreadyRegisteredError` (see ../domain/errors.ts) if the
   * address is taken.
   *
   * Part of the contract rather than left to each implementation, so that a
   * duplicate registration reaches business logic as a domain error instead of
   * a driver-specific unique-violation. It also means the check survives the
   * race between "is this address free?" and the insert: the unique index is
   * the authority, not the earlier read.
   */
  create(input: NewUser): Promise<User>;
}

export interface TaskRepository {
  /** Null when the task does not exist *or* belongs to another user. */
  findByIdForUser(taskId: string, userId: string): Promise<Task | null>;
  /** FR2 default ordering: by deadline, undated tasks last, then by creation. */
  listForUser(userId: string): Promise<Task[]>;
  create(input: NewTask): Promise<Task>;
  /** Null when the task does not exist or belongs to another user. */
  update(taskId: string, userId: string, changes: TaskChanges): Promise<Task | null>;
  /** False when the task does not exist or belongs to another user. */
  delete(taskId: string, userId: string): Promise<boolean>;
}

export interface ClaimDueRemindersInput {
  /** Reminders firing at or before this instant are eligible. */
  readonly now: Date;
  readonly limit: number;
  /** Reminders that have already failed this many times are abandoned. */
  readonly maxAttempts: number;
}

export interface ReminderRepository {
  /** The outstanding reminder for a task, if it has one. */
  findPendingForTask(taskId: string): Promise<Reminder | null>;
  create(input: NewReminder): Promise<Reminder>;
  /** Moves an outstanding reminder because the task's deadline changed. */
  updateFireTime(reminderId: string, fireAt: Date): Promise<void>;
  /** Removes unsent reminders for a task. Delivered ones are kept as history. */
  deletePendingForTask(taskId: string): Promise<number>;

  /**
   * Claims up to `limit` reminders that are due and undelivered, locking them
   * against other workers for the remainder of the transaction. Implemented
   * with `SELECT ... FOR UPDATE SKIP LOCKED`, which is why this method must
   * only ever be called inside a {@link UnitOfWork}.
   */
  claimDue(input: ClaimDueRemindersInput): Promise<DueReminder[]>;

  markSent(reminderId: string, sentAt: Date): Promise<void>;
  /** Increments `attempts` and records the reason, leaving `sent_at` null. */
  recordFailure(reminderId: string, error: string): Promise<void>;
}

export interface Repositories {
  readonly users: UserRepository;
  readonly tasks: TaskRepository;
  readonly reminders: ReminderRepository;
}

/**
 * Runs a piece of work atomically. The repositories passed to `work` are bound
 * to the transaction; if `work` throws, everything it did is rolled back.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
