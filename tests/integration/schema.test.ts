/**
 * Proves the schema the report describes is the schema the migrations produce,
 * and that a fresh database ends up seeded and usable with no manual steps.
 */
import { seedDemoData, DEMO_EMAIL } from '@tasks/data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupTestDatabase, type TestDatabase } from '../support/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await setupTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

const columnsOf = async (table: string): Promise<Map<string, string>> => {
  const { rows } = await database.pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
};

describe('schema', () => {
  it('creates the three application tables with snake_case columns', async () => {
    const users = await columnsOf('users');
    const tasks = await columnsOf('tasks');
    const reminders = await columnsOf('reminders');

    expect([...users.keys()].sort()).toEqual([
      'created_at',
      'email',
      'id',
      'password_hash',
      'timezone',
    ]);

    expect([...tasks.keys()].sort()).toEqual([
      'completed_at',
      'created_at',
      'description',
      'due_at',
      'id',
      'parent_task_id',
      'priority',
      'recurrence',
      'reminder_offset_minutes',
      'status',
      'title',
      'user_id',
    ]);

    expect([...reminders.keys()].sort()).toEqual([
      'attempts',
      'created_at',
      'due_at',
      'id',
      'last_error',
      'sent_at',
      'task_id',
    ]);
  });

  it('stores every timestamp as timestamptz', async () => {
    for (const table of ['users', 'tasks', 'reminders']) {
      const columns = await columnsOf(table);
      for (const [name, dataType] of columns) {
        if (name.endsWith('_at')) {
          expect(`${table}.${name}: ${dataType}`).toBe(
            `${table}.${name}: timestamp with time zone`,
          );
        }
      }
    }
  });

  it('rejects a recurrence rule that is not one of the four supported forms', async () => {
    const { rows } = await database.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'x') RETURNING id`,
    );
    const userId = rows[0]?.id;
    expect(userId).toBeDefined();

    await expect(
      database.pool.query(`INSERT INTO tasks (user_id, title, recurrence) VALUES ($1, 'bad', $2)`, [
        userId,
        'fortnightly',
      ]),
    ).rejects.toThrow(/tasks_recurrence_valid/);

    await expect(
      database.pool.query(`INSERT INTO tasks (user_id, title, recurrence) VALUES ($1, 'ok', $2)`, [
        userId,
        'every:3d',
      ]),
    ).resolves.toBeDefined();
  });
});

describe('seed', () => {
  it('populates a demo user with tasks in varied states', async () => {
    const result = await seedDemoData(database.db, { passwordHash: 'not-a-real-hash' });

    expect(result.seeded).toBe(true);
    expect(result.taskCount).toBeGreaterThanOrEqual(15);

    const { rows } = await database.pool.query<{
      email: string;
      open_count: string;
      done_count: string;
      recurring_count: string;
      overdue_count: string;
      child_count: string;
    }>(
      `SELECT u.email,
              count(*) FILTER (WHERE t.status = 'open')            AS open_count,
              count(*) FILTER (WHERE t.status = 'done')            AS done_count,
              count(*) FILTER (WHERE t.recurrence IS NOT NULL)     AS recurring_count,
              count(*) FILTER (WHERE t.due_at < now()
                                 AND t.status = 'open')            AS overdue_count,
              count(*) FILTER (WHERE t.parent_task_id IS NOT NULL) AS child_count
         FROM users u JOIN tasks t ON t.user_id = u.id
        GROUP BY u.email`,
    );

    const summary = rows[0];
    expect(summary?.email).toBe(DEMO_EMAIL);
    expect(Number(summary?.open_count)).toBeGreaterThan(0);
    expect(Number(summary?.done_count)).toBeGreaterThan(0);
    expect(Number(summary?.recurring_count)).toBeGreaterThan(0);
    expect(Number(summary?.overdue_count)).toBeGreaterThan(0);
    expect(Number(summary?.child_count)).toBeGreaterThan(0);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const first = await seedDemoData(database.db, { passwordHash: 'not-a-real-hash' });
    const second = await seedDemoData(database.db, { passwordHash: 'not-a-real-hash' });

    expect(first.seeded).toBe(true);
    expect(second.seeded).toBe(false);

    const { rows } = await database.pool.query<{ count: string }>('SELECT count(*) FROM users');
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('leaves a pending reminder for tasks whose reminder has not yet come round', async () => {
    await seedDemoData(database.db, { passwordHash: 'not-a-real-hash' });

    const { rows } = await database.pool.query<{ pending: string }>(
      `SELECT count(*) AS pending FROM reminders WHERE sent_at IS NULL`,
    );
    expect(Number(rows[0]?.pending)).toBeGreaterThan(0);
  });
});
