/**
 * @tasks/core - Layer 2, business logic.
 *
 * Everything exported from here is pure TypeScript: recurrence arithmetic,
 * reminder scheduling policy and task state transitions. This layer never
 * touches HTTP, SQL, the ORM or the clock directly. Anything it needs from the
 * outside world arrives as a port (an interface declared in `./ports`) that a
 * lower layer implements and the composition root injects.
 *
 * All instants crossing this boundary are UTC. This layer has no concept of a
 * user's timezone; conversion is the presentation layer's job.
 */

export {
  everyNDays,
  parseRecurrenceRule,
  RECURRENCE_KEYWORDS,
  type DueReminder,
  type NewReminder,
  type NewTask,
  type NewUser,
  type RecurrenceRule,
  type Reminder,
  type Task,
  type TaskChanges,
  type TaskPriority,
  type TaskStatus,
  type User,
} from './domain/types.js';

export {
  DomainError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  TaskNotFoundError,
  ValidationError,
} from './domain/errors.js';

export type {
  ClaimDueRemindersInput,
  Repositories,
  ReminderRepository,
  TaskRepository,
  UnitOfWork,
  UserRepository,
} from './ports/repositories.js';

export type { Clock, PasswordHasher, ReminderNotifier } from './ports/services.js';

export { nextOccurrence } from './recurrence.js';

export {
  createAuthService,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type AuthService,
  type AuthServiceDependencies,
  type RegisterInput,
} from './auth/auth-service.js';

export {
  DEFAULT_REMINDER_OFFSET_MINUTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_REMINDER_OFFSET_MINUTES,
  MAX_TITLE_LENGTH,
  normaliseTaskAttributes,
  validateTaskAttributes,
  type TaskAttributes,
} from './tasks/validation.js';

export {
  createTaskService,
  type CompleteTaskResult,
  type CreateTaskInput,
  type TaskService,
  type TaskServiceDependencies,
  type UpdateTaskInput,
} from './tasks/task-service.js';

export { computeReminderFireTime, synchroniseReminder } from './reminders/policy.js';

export {
  MAX_DELIVERY_ATTEMPTS,
  REMINDER_BATCH_LIMIT,
  runReminderTick,
  type ReminderTickDependencies,
  type ReminderTickResult,
} from './reminders/tick.js';
