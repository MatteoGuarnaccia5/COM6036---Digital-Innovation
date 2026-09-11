/**
 * One task in the list.
 *
 * Status is never carried by colour alone: overdue, priority and completion are
 * all words as well as styling, so the list is readable with a colour vision
 * deficiency or in a high-contrast mode.
 */
import type { JSX } from 'react';

import type { TaskDto } from '../../shared/api-types';

interface TaskItemProps {
  readonly task: TaskDto;
  readonly onEdit: (task: TaskDto) => void;
  readonly onComplete: (task: TaskDto) => void;
  readonly onDelete: (task: TaskDto) => void;
  readonly busy: boolean;
}

const PRIORITY_LABEL: Record<TaskDto['priority'], string> = {
  low: 'Low priority',
  medium: 'Medium priority',
  high: 'High priority',
};

const RECURRENCE_LABEL = (rule: string): string => {
  const every = /^every:(\d+)d$/.exec(rule);
  if (every !== null) return `Repeats every ${every[1] ?? '?'} days`;
  return `Repeats ${rule}`;
};

function isOverdue(task: TaskDto): boolean {
  return task.status === 'open' && task.dueAt !== null && new Date(task.dueAt.utc) < new Date();
}

export function TaskItem({
  task,
  onEdit,
  onComplete,
  onDelete,
  busy,
}: TaskItemProps): JSX.Element {
  const done = task.status === 'done';
  const overdue = isOverdue(task);

  return (
    <li className={`task${done ? ' task--done' : ''}`}>
      <div className="task__body">
        <h3 className="task__title">{task.title}</h3>

        {task.description !== null && <p className="task__description">{task.description}</p>}

        <p className="task__meta">
          {task.dueAt === null ? (
            <span className="task__due">No deadline</span>
          ) : (
            <span className="task__due">
              Due <time dateTime={task.dueAt.utc}>{task.dueAt.display}</time>
            </span>
          )}

          {overdue && <span className="badge badge--overdue">Overdue</span>}
          {done && <span className="badge badge--done">Completed</span>}
          <span className={`badge badge--priority-${task.priority}`}>
            {PRIORITY_LABEL[task.priority]}
          </span>
          {task.recurrence !== null && (
            <span className="badge">{RECURRENCE_LABEL(task.recurrence)}</span>
          )}
          {task.parentTaskId !== null && <span className="badge">Generated occurrence</span>}
        </p>
      </div>

      <div className="task__actions">
        {!done && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onComplete(task);
            }}
            disabled={busy}
          >
            {/* The visible label is short; the accessible name says which task. */}
            <span aria-hidden="true">Complete</span>
            <span className="visually-hidden">Mark “{task.title}” complete</span>
          </button>
        )}

        <button
          type="button"
          className="button"
          onClick={() => {
            onEdit(task);
          }}
          disabled={busy}
        >
          <span aria-hidden="true">Edit</span>
          <span className="visually-hidden">Edit “{task.title}”</span>
        </button>

        <button
          type="button"
          className="button button--danger"
          onClick={() => {
            onDelete(task);
          }}
          disabled={busy}
        >
          <span aria-hidden="true">Delete</span>
          <span className="visually-hidden">Delete “{task.title}”</span>
        </button>
      </div>
    </li>
  );
}
