/**
 * Domain objects to JSON.
 *
 * Two rules are enforced here rather than trusted to each handler:
 *
 *  1. A password hash never leaves the process. The user representation is
 *     built field by field, so adding a column to the table cannot
 *     accidentally publish it.
 *
 *  2. Every instant is published three ways - canonical UTC, a value an
 *     `<input type="datetime-local">` accepts, and something readable - all in
 *     the user's timezone. The conversion happens here because this is the
 *     presentation layer; nothing beneath it has ever seen a local time.
 *
 * The shapes themselves live in ../../shared/api-types.ts, which the React
 * client also imports, so the two halves cannot drift apart silently.
 */
import type { Task, User } from '@tasks/core';

import type { InstantDto, TaskDto, UserDto } from '../../shared/api-types.js';
import { formatForDisplay, toLocalInputValue } from './timezone.js';

export function toUserResponse(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    timezone: user.timezone,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toInstantResponse(instant: Date, timeZone: string): InstantDto {
  return {
    utc: instant.toISOString(),
    local: toLocalInputValue(instant, timeZone),
    display: formatForDisplay(instant, timeZone),
  };
}

export function toTaskResponse(task: Task, timeZone: string): TaskDto {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    dueAt: task.dueAt === null ? null : toInstantResponse(task.dueAt, timeZone),
    priority: task.priority,
    status: task.status,
    recurrence: task.recurrence,
    parentTaskId: task.parentTaskId,
    reminderOffsetMinutes: task.reminderOffsetMinutes,
    createdAt: toInstantResponse(task.createdAt, timeZone),
    completedAt: task.completedAt === null ? null : toInstantResponse(task.completedAt, timeZone),
    timezone: timeZone,
  };
}
