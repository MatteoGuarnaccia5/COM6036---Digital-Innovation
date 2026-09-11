/**
 * FR8 - the JSON API for tasks, under /api/v1.
 *
 * These handlers are deliberately thin. Each one does exactly four things:
 * check the shape of the request, convert the user's local time into a UTC
 * instant, call the business logic, and serialise the result. There is no
 * business rule in this file and no SQL - a recurrence is not advanced here, a
 * reminder is not scheduled here, and ownership is not checked here.
 *
 * ## Ownership
 *
 * Nothing below compares a task's `userId` against the session. It does not
 * need to: every service call takes the authenticated user's id and the
 * repository has no unscoped lookup, so another user's task raises
 * `TaskNotFoundError` and leaves as a 404. That is the whole mechanism - see
 * tests/integration/task-isolation.test.ts.
 *
 * ## Time
 *
 * A deadline arrives as a naive wall-clock string and is interpreted in the
 * account's timezone; it leaves as UTC plus two rendered forms. This is the
 * only layer that knows the user has a timezone at all.
 */
import { parseRecurrenceRule, TaskNotFoundError, type RecurrenceRule, type TaskService } from '@tasks/core';
import { Router } from 'express';
import { z } from 'zod';

import { toTaskResponse } from '../presentation/serializers.js';
import { currentUser } from '../presentation/session.js';
import { parseLocalDateTime } from '../presentation/timezone.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const prioritySchema = z.enum(['low', 'medium', 'high']);

const recurrenceSchema = z.string().refine((value) => parseRecurrenceRule(value) !== null, {
  message: 'Recurrence must be daily, weekly, monthly, or every:Nd',
});

/** `.nullable().optional()` is what distinguishes "leave alone" from "clear". */
const createTaskBody = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  priority: prioritySchema.optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  reminderOffsetMinutes: z.number().int().optional(),
});

const updateTaskBody = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  priority: prioritySchema.optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  reminderOffsetMinutes: z.number().int().optional(),
});

/**
 * A malformed id is reported as 404 rather than 400.
 *
 * It also stops a non-UUID reaching Postgres, where it would raise a syntax
 * error and surface as a 500. Answering "not found" is both the honest reply -
 * no such task exists - and consistent with how another user's id is treated.
 */
function requireTaskId(rawId: string | undefined): string {
  if (rawId === undefined || !UUID_PATTERN.test(rawId)) throw new TaskNotFoundError();
  return rawId;
}

const toDeadline = (value: string | null | undefined, timeZone: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseLocalDateTime(value, timeZone);
};

const toRecurrence = (value: string | null | undefined): RecurrenceRule | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  /* The schema has already refused anything unparseable. */
  return parseRecurrenceRule(value);
};

export function createTaskRouter(taskService: TaskService): Router {
  const router = Router();

  /* FR2 - listing. No query parameters: filtering and sorting beyond the
     default due-date ordering are explicitly out of scope. */
  router.get('/', async (request, response) => {
    const user = currentUser(request);
    const tasks = await taskService.list(user.id);

    response.json({ tasks: tasks.map((task) => toTaskResponse(task, user.timezone)) });
  });

  router.post('/', async (request, response) => {
    const user = currentUser(request);
    const body = createTaskBody.parse(request.body);

    const task = await taskService.create({
      userId: user.id,
      title: body.title,
      description: body.description ?? null,
      dueAt: toDeadline(body.dueAt, user.timezone) ?? null,
      priority: body.priority ?? 'medium',
      recurrence: toRecurrence(body.recurrence) ?? null,
      ...(body.reminderOffsetMinutes !== undefined && {
        reminderOffsetMinutes: body.reminderOffsetMinutes,
      }),
    });

    response.status(201).json({ task: toTaskResponse(task, user.timezone) });
  });

  router.get('/:id', async (request, response) => {
    const user = currentUser(request);
    const task = await taskService.get(user.id, requireTaskId(request.params.id));

    response.json({ task: toTaskResponse(task, user.timezone) });
  });

  router.patch('/:id', async (request, response) => {
    const user = currentUser(request);
    const body = updateTaskBody.parse(request.body);

    const deadline = toDeadline(body.dueAt, user.timezone);
    const recurrence = toRecurrence(body.recurrence);

    const task = await taskService.update(user.id, requireTaskId(request.params.id), {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(deadline !== undefined && { dueAt: deadline }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(recurrence !== undefined && { recurrence }),
      ...(body.reminderOffsetMinutes !== undefined && {
        reminderOffsetMinutes: body.reminderOffsetMinutes,
      }),
    });

    response.json({ task: toTaskResponse(task, user.timezone) });
  });

  /*
   * FR3. A sub-resource action rather than `PATCH { status: 'done' }`, because
   * completing a task is a state transition with consequences - it drops the
   * pending reminder and may generate the next occurrence - not a field
   * assignment. Keeping it off the update route means there is exactly one code
   * path that can complete a task.
   */
  router.post('/:id/complete', async (request, response) => {
    const user = currentUser(request);
    const result = await taskService.complete(user.id, requireTaskId(request.params.id));

    response.json({
      task: toTaskResponse(result.task, user.timezone),
      nextOccurrence:
        result.nextOccurrence === null
          ? null
          : toTaskResponse(result.nextOccurrence, user.timezone),
    });
  });

  router.delete('/:id', async (request, response) => {
    const user = currentUser(request);
    await taskService.remove(user.id, requireTaskId(request.params.id));

    response.status(204).end();
  });

  return router;
}
