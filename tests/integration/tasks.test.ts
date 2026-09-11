/**
 * FR2, FR3, FR4 and FR8 over HTTP, against the real application and database.
 *
 * The cross-user 404 lives here too: the isolation mechanism is already proven
 * at the repository and service layers, and this checks that the API surface
 * does not undo it - that no route reports 403, and that another user's task id
 * is answered exactly as an id that was never issued.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupTestApp, type TestApp } from '../support/app.js';

let testApp: TestApp;

const PASSWORD = 'correct-horse-battery';

/** Registers an account and returns an agent that keeps its session cookie. */
async function signUp(email: string, timezone = 'Europe/London'): Promise<request.Agent> {
  const agent = request.agent(testApp.app);
  await agent
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, timezone })
    .expect(201);
  return agent;
}

const newTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Write the report',
  description: 'Second draft',
  dueAt: '2026-05-06T17:00',
  priority: 'high',
  ...overrides,
});

beforeAll(async () => {
  testApp = await setupTestApp();
});

afterAll(async () => {
  await testApp.close();
});

beforeEach(async () => {
  await testApp.reset();
});

describe('authentication is required', () => {
  it('refuses every task route to an anonymous caller', async () => {
    const id = '11111111-1111-1111-1111-111111111111';

    await request(testApp.app).get('/api/v1/tasks').expect(401);
    await request(testApp.app).post('/api/v1/tasks').send(newTask()).expect(401);
    await request(testApp.app).get(`/api/v1/tasks/${id}`).expect(401);
    await request(testApp.app).patch(`/api/v1/tasks/${id}`).send({ title: 'x' }).expect(401);
    await request(testApp.app).post(`/api/v1/tasks/${id}/complete`).expect(401);
    await request(testApp.app).delete(`/api/v1/tasks/${id}`).expect(401);
  });
});

describe('POST /api/v1/tasks', () => {
  it('creates a task and returns it', async () => {
    const agent = await signUp('owner@example.com');

    const response = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    expect(response.body.task).toMatchObject({
      title: 'Write the report',
      description: 'Second draft',
      priority: 'high',
      status: 'open',
      recurrence: null,
      parentTaskId: null,
      reminderOffsetMinutes: 60,
      completedAt: null,
    });
    expect(response.body.task.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('schedules a reminder at the deadline minus the offset', async () => {
    const agent = await signUp('owner@example.com');

    const response = await agent
      .post('/api/v1/tasks')
      .send(newTask({ dueAt: '2026-05-06T17:00', reminderOffsetMinutes: 120 }))
      .expect(201);

    const { rows } = await testApp.database.pool.query<{ due_at: Date }>(
      'SELECT due_at FROM reminders WHERE task_id = $1',
      [response.body.task.id],
    );
    /* 17:00 London in May is 16:00 UTC; two hours earlier is 14:00 UTC. */
    expect(rows[0]?.due_at.toISOString()).toBe('2026-05-06T14:00:00.000Z');
  });

  it('rejects a blank title and an unsupported recurrence with 400 and a field', async () => {
    const agent = await signUp('owner@example.com');

    const blank = await agent.post('/api/v1/tasks').send(newTask({ title: '  ' })).expect(400);
    expect(blank.body.error.field).toBe('title');

    const badRule = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'fortnightly' }))
      .expect(400);
    expect(badRule.body.error.field).toBe('recurrence');
  });

  it('rejects a recurring task with no deadline to advance', async () => {
    const agent = await signUp('owner@example.com');

    const response = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'weekly', dueAt: null }))
      .expect(400);

    expect(response.body.error.message).toMatch(/due date/i);
  });

  it('rejects a date that is not a date', async () => {
    const agent = await signUp('owner@example.com');

    await agent.post('/api/v1/tasks').send(newTask({ dueAt: 'next Tuesday' })).expect(400);
  });
});

describe('timezone conversion', () => {
  it('interprets a deadline in the account’s zone and stores UTC', async () => {
    const london = await signUp('london@example.com', 'Europe/London');
    const newYork = await signUp('ny@example.com', 'America/New_York');

    const fromLondon = await london
      .post('/api/v1/tasks')
      .send(newTask({ dueAt: '2026-07-01T09:00' }))
      .expect(201);
    const fromNewYork = await newYork
      .post('/api/v1/tasks')
      .send(newTask({ dueAt: '2026-07-01T09:00' }))
      .expect(201);

    /* The same wall clock, two zones, two different instants - which is the
       whole reason conversion happens at this layer. */
    expect(fromLondon.body.task.dueAt.utc).toBe('2026-07-01T08:00:00.000Z');
    expect(fromNewYork.body.task.dueAt.utc).toBe('2026-07-01T13:00:00.000Z');
  });

  it('round-trips a local time unchanged, either side of a DST boundary', async () => {
    const agent = await signUp('london@example.com', 'Europe/London');

    /* British Summer Time began on 29 March 2026. */
    for (const local of ['2026-03-28T09:00', '2026-03-30T09:00', '2026-12-01T09:00']) {
      const response = await agent.post('/api/v1/tasks').send(newTask({ dueAt: local })).expect(201);
      expect(response.body.task.dueAt.local).toBe(local);
    }
  });

  it('stores the same instant for the same moment written in two zones', async () => {
    const london = await signUp('london@example.com', 'Europe/London');
    const newYork = await signUp('ny@example.com', 'America/New_York');

    /* 13:00 London on 1 July is 08:00 New York. */
    const a = await london.post('/api/v1/tasks').send(newTask({ dueAt: '2026-07-01T13:00' }));
    const b = await newYork.post('/api/v1/tasks').send(newTask({ dueAt: '2026-07-01T08:00' }));

    expect(a.body.task.dueAt.utc).toBe(b.body.task.dueAt.utc);
  });

  it('publishes every instant as UTC alongside its local rendering', async () => {
    const agent = await signUp('ny@example.com', 'America/New_York');

    const response = await agent
      .post('/api/v1/tasks')
      .send(newTask({ dueAt: '2026-07-01T09:00' }))
      .expect(201);

    expect(response.body.task.dueAt).toEqual({
      utc: '2026-07-01T13:00:00.000Z',
      local: '2026-07-01T09:00',
      display: expect.stringContaining('2026'),
    });
    expect(response.body.task.timezone).toBe('America/New_York');
  });
});

describe('GET /api/v1/tasks', () => {
  it('lists the user’s tasks by deadline, undated last', async () => {
    const agent = await signUp('owner@example.com');

    await agent.post('/api/v1/tasks').send(newTask({ title: 'later', dueAt: '2026-05-20T09:00' }));
    await agent.post('/api/v1/tasks').send(newTask({ title: 'undated', dueAt: null }));
    await agent.post('/api/v1/tasks').send(newTask({ title: 'sooner', dueAt: '2026-05-06T09:00' }));

    const response = await agent.get('/api/v1/tasks').expect(200);

    expect(response.body.tasks.map((task: { title: string }) => task.title)).toEqual([
      'sooner',
      'later',
      'undated',
    ]);
  });

  it('shows one user nothing of another’s', async () => {
    const owner = await signUp('owner@example.com');
    const other = await signUp('other@example.com');
    await owner.post('/api/v1/tasks').send(newTask({ title: 'private' })).expect(201);

    await expect(other.get('/api/v1/tasks').expect(200)).resolves.toMatchObject({
      body: { tasks: [] },
    });
  });
});

describe('PATCH /api/v1/tasks/:id', () => {
  it('changes only the fields it mentions', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    const response = await agent
      .patch(`/api/v1/tasks/${created.body.task.id}`)
      .send({ title: 'Renamed' })
      .expect(200);

    expect(response.body.task).toMatchObject({
      title: 'Renamed',
      description: 'Second draft',
      priority: 'high',
    });
    expect(response.body.task.dueAt.utc).toBe(created.body.task.dueAt.utc);
  });

  it('moves the pending reminder when the deadline moves', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    await agent
      .patch(`/api/v1/tasks/${created.body.task.id}`)
      .send({ dueAt: '2026-05-09T17:00' })
      .expect(200);

    const { rows } = await testApp.database.pool.query<{ due_at: Date; count: string }>(
      'SELECT due_at FROM reminders WHERE task_id = $1',
      [created.body.task.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.due_at.toISOString()).toBe('2026-05-09T15:00:00.000Z');
  });

  it('clears the deadline and removes the reminder when dueAt is null', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    const response = await agent
      .patch(`/api/v1/tasks/${created.body.task.id}`)
      .send({ dueAt: null })
      .expect(200);

    expect(response.body.task.dueAt).toBeNull();

    const { rows } = await testApp.database.pool.query<{ count: string }>(
      'SELECT count(*) FROM reminders WHERE task_id = $1',
      [created.body.task.id],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('POST /api/v1/tasks/:id/complete', () => {
  it('completes a one-off task and generates nothing', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    const response = await agent
      .post(`/api/v1/tasks/${created.body.task.id}/complete`)
      .expect(200);

    expect(response.body.task.status).toBe('done');
    expect(response.body.task.completedAt).not.toBeNull();
    expect(response.body.nextOccurrence).toBeNull();
  });

  it('generates the next occurrence of a recurring task, linked to the root', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'weekly', dueAt: '2026-05-06T17:00' }))
      .expect(201);

    const response = await agent
      .post(`/api/v1/tasks/${created.body.task.id}/complete`)
      .expect(200);

    expect(response.body.nextOccurrence).toMatchObject({
      title: 'Write the report',
      recurrence: 'weekly',
      status: 'open',
      parentTaskId: created.body.task.id,
    });
    expect(response.body.nextOccurrence.dueAt.local).toBe('2026-05-13T17:00');
  });

  it('advances every:Nd and monthly correctly', async () => {
    const agent = await signUp('owner@example.com');

    const everyThreeDays = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'every:3d', dueAt: '2026-05-06T17:00' }));
    const monthly = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'monthly', dueAt: '2026-01-31T09:00' }));

    const advancedDays = await agent
      .post(`/api/v1/tasks/${everyThreeDays.body.task.id}/complete`)
      .expect(200);
    const advancedMonth = await agent
      .post(`/api/v1/tasks/${monthly.body.task.id}/complete`)
      .expect(200);

    expect(advancedDays.body.nextOccurrence.dueAt.local).toBe('2026-05-09T17:00');
    /* January has 31 days, February 28 in 2026: clamped, as documented. */
    expect(advancedMonth.body.nextOccurrence.dueAt.local).toBe('2026-02-28T09:00');
  });

  it('is idempotent, so a double-clicked button cannot generate two occurrences', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent
      .post('/api/v1/tasks')
      .send(newTask({ recurrence: 'daily' }))
      .expect(201);

    await agent.post(`/api/v1/tasks/${created.body.task.id}/complete`).expect(200);
    const second = await agent.post(`/api/v1/tasks/${created.body.task.id}/complete`).expect(200);

    expect(second.body.nextOccurrence).toBeNull();
    const listed = await agent.get('/api/v1/tasks').expect(200);
    expect(listed.body.tasks).toHaveLength(2);
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  it('deletes the task and its reminder, then reports it gone', async () => {
    const agent = await signUp('owner@example.com');
    const created = await agent.post('/api/v1/tasks').send(newTask()).expect(201);

    await agent.delete(`/api/v1/tasks/${created.body.task.id}`).expect(204);
    await agent.get(`/api/v1/tasks/${created.body.task.id}`).expect(404);

    const { rows } = await testApp.database.pool.query<{ count: string }>(
      'SELECT count(*) FROM reminders WHERE task_id = $1',
      [created.body.task.id],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('one user’s task is invisible to another', () => {
  const NEVER_ISSUED = '00000000-0000-0000-0000-000000000000';

  it('answers 404 - never 403 - on every route', async () => {
    const owner = await signUp('owner@example.com');
    const intruder = await signUp('intruder@example.com');
    const created = await owner.post('/api/v1/tasks').send(newTask()).expect(201);
    const id = created.body.task.id;

    await intruder.get(`/api/v1/tasks/${id}`).expect(404);
    await intruder.patch(`/api/v1/tasks/${id}`).send({ title: 'hijacked' }).expect(404);
    await intruder.post(`/api/v1/tasks/${id}/complete`).expect(404);
    await intruder.delete(`/api/v1/tasks/${id}`).expect(404);

    /* And nothing happened to it. */
    const untouched = await owner.get(`/api/v1/tasks/${id}`).expect(200);
    expect(untouched.body.task).toMatchObject({ title: 'Write the report', status: 'open' });
  });

  it('is indistinguishable from an id that was never issued', async () => {
    const owner = await signUp('owner@example.com');
    const intruder = await signUp('intruder@example.com');
    const created = await owner.post('/api/v1/tasks').send(newTask()).expect(201);

    const someoneElses = await intruder.get(`/api/v1/tasks/${created.body.task.id}`).expect(404);
    const nonexistent = await intruder.get(`/api/v1/tasks/${NEVER_ISSUED}`).expect(404);

    /* Byte-identical: the API cannot be used to discover which ids are real. */
    expect(someoneElses.body).toEqual(nonexistent.body);
  });

  it('answers a malformed id with 404 rather than a server error', async () => {
    const agent = await signUp('owner@example.com');

    await agent.get('/api/v1/tasks/not-a-uuid').expect(404);
    await agent.delete('/api/v1/tasks/12345').expect(404);
  });
});
