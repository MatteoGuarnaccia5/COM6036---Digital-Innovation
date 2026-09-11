/**
 * @tasks/data - Layer 3, data access.
 *
 * Drizzle schema, migrations, and the repository implementations that satisfy
 * the port interfaces declared in @tasks/core. No SQL, no ORM call and no
 * connection pool exists anywhere else in this repository.
 *
 * Every timestamp read from or written to Postgres is UTC (`timestamptz`).
 */

export {
  createDatabase,
  createPool,
  schema,
  type ConnectionPool,
  type Database,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from './client.js';

export { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

export {
  shiftReminderIntoThePast,
  type ShiftedReminder,
  type ShiftReminderOptions,
} from './demo-tools.js';

export {
  createReminderRepository,
  createRepositories,
  createTaskRepository,
  createUnitOfWork,
  createUserRepository,
} from './repositories/index.js';

export {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DEMO_TIMEZONE,
  seedDemoData,
  type SeedOptions,
  type SeedResult,
} from './seed.js';

export {
  reminders,
  taskPriority,
  taskStatus,
  tasks,
  users,
  type ReminderRow,
  type TaskRow,
  type UserRow,
} from './schema.js';

export { sessions } from './session-schema.js';
