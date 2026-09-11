import type { NewTask, Task, TaskChanges, TaskRepository } from '@tasks/core';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { DatabaseExecutor } from '../client.js';
import { tasks } from '../schema.js';
import { toTask } from './mappers.js';

/**
 * Ownership is part of every query rather than a check applied to the result.
 * A task belonging to somebody else and a task that does not exist produce the
 * same empty result set, so the presentation layer has nothing to leak even if
 * it wanted to.
 */
const ownedBy = (taskId: string, userId: string) =>
  and(eq(tasks.id, taskId), eq(tasks.userId, userId));

export function createTaskRepository(executor: DatabaseExecutor): TaskRepository {
  return {
    async findByIdForUser(taskId: string, userId: string): Promise<Task | null> {
      const [row] = await executor.select().from(tasks).where(ownedBy(taskId, userId)).limit(1);
      return row === undefined ? null : toTask(row);
    },

    async listForUser(userId: string): Promise<Task[]> {
      const rows = await executor
        .select()
        .from(tasks)
        .where(eq(tasks.userId, userId))
        /* FR2 default ordering: soonest deadline first, undated tasks last,
           ties broken by creation order so the list is stable. */
        .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, asc(tasks.createdAt));
      return rows.map(toTask);
    },

    async create(input: NewTask): Promise<Task> {
      const [row] = await executor
        .insert(tasks)
        .values({
          userId: input.userId,
          title: input.title,
          description: input.description,
          dueAt: input.dueAt,
          priority: input.priority,
          recurrence: input.recurrence,
          parentTaskId: input.parentTaskId,
          reminderOffsetMinutes: input.reminderOffsetMinutes,
        })
        .returning();

      if (row === undefined) throw new Error('Insert into tasks returned no row');
      return toTask(row);
    },

    async update(taskId: string, userId: string, changes: TaskChanges): Promise<Task | null> {
      /* Built key by key: an absent property leaves the column alone, whereas
         an explicit null clears it. */
      const values: Partial<typeof tasks.$inferInsert> = {};
      if (changes.title !== undefined) values.title = changes.title;
      if (changes.description !== undefined) values.description = changes.description;
      if (changes.dueAt !== undefined) values.dueAt = changes.dueAt;
      if (changes.priority !== undefined) values.priority = changes.priority;
      if (changes.recurrence !== undefined) values.recurrence = changes.recurrence;
      if (changes.reminderOffsetMinutes !== undefined) {
        values.reminderOffsetMinutes = changes.reminderOffsetMinutes;
      }
      if (changes.status !== undefined) values.status = changes.status;
      if (changes.completedAt !== undefined) values.completedAt = changes.completedAt;

      if (Object.keys(values).length === 0) {
        const [unchanged] = await executor
          .select()
          .from(tasks)
          .where(ownedBy(taskId, userId))
          .limit(1);
        return unchanged === undefined ? null : toTask(unchanged);
      }

      const [row] = await executor
        .update(tasks)
        .set(values)
        .where(ownedBy(taskId, userId))
        .returning();
      return row === undefined ? null : toTask(row);
    },

    async delete(taskId: string, userId: string): Promise<boolean> {
      const deleted = await executor
        .delete(tasks)
        .where(ownedBy(taskId, userId))
        .returning({ id: tasks.id });
      return deleted.length > 0;
    },
  };
}
