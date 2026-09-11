/**
 * The task form, shared by the inline "add" affordance and by editing.
 *
 * The same fields serve both, so a task created quickly and a task edited later
 * cannot disagree about what a priority or a recurrence rule is.
 *
 * Dates are handled as naive local strings throughout - exactly what
 * `<input type="datetime-local">` produces, and exactly what the API expects.
 * The browser never computes an instant and the client never sends a UTC value:
 * the conversion belongs to the server's presentation layer, which knows the
 * account's timezone.
 */
import { useId, type FormEvent, type JSX } from 'react';

import type { TaskDto, TaskPriorityDto } from '../../shared/api-types';
import type { TaskInput } from '../api';

type RecurrenceKind = 'none' | 'daily' | 'weekly' | 'monthly' | 'every';

export interface TaskFormValues {
  readonly title: string;
  readonly description: string;
  /** `YYYY-MM-DDTHH:mm`, or empty for no deadline. */
  readonly dueAt: string;
  readonly priority: TaskPriorityDto;
  readonly recurrenceKind: RecurrenceKind;
  readonly everyDays: string;
  readonly reminderOffsetMinutes: string;
}

export const emptyTaskFormValues: TaskFormValues = {
  title: '',
  description: '',
  dueAt: '',
  priority: 'medium',
  recurrenceKind: 'none',
  everyDays: '3',
  reminderOffsetMinutes: '60',
};

const EVERY_N_DAYS = /^every:(\d+)d$/;

export function taskToFormValues(task: TaskDto): TaskFormValues {
  const everyMatch = task.recurrence === null ? null : EVERY_N_DAYS.exec(task.recurrence);

  return {
    title: task.title,
    description: task.description ?? '',
    dueAt: task.dueAt?.local ?? '',
    priority: task.priority,
    recurrenceKind:
      task.recurrence === null
        ? 'none'
        : everyMatch !== null
          ? 'every'
          : (task.recurrence as RecurrenceKind),
    everyDays: everyMatch?.[1] ?? '3',
    reminderOffsetMinutes: String(task.reminderOffsetMinutes),
  };
}

export function formValuesToInput(values: TaskFormValues): TaskInput {
  const recurrence =
    values.recurrenceKind === 'none'
      ? null
      : values.recurrenceKind === 'every'
        ? `every:${values.everyDays.trim()}d`
        : values.recurrenceKind;

  const description = values.description.trim();
  const offset = Number.parseInt(values.reminderOffsetMinutes, 10);

  return {
    title: values.title.trim(),
    description: description === '' ? null : description,
    dueAt: values.dueAt === '' ? null : values.dueAt,
    priority: values.priority,
    recurrence,
    reminderOffsetMinutes: Number.isFinite(offset) ? offset : 60,
  };
}

interface TaskDetailFieldsProps {
  readonly values: TaskFormValues;
  readonly onChange: (values: TaskFormValues) => void;
  /** Distinguishes the ids when two forms are on the page at once. */
  readonly idPrefix: string;
}

/** Everything except the title, which the quick-add form renders on its own. */
export function TaskDetailFields({
  values,
  onChange,
  idPrefix,
}: TaskDetailFieldsProps): JSX.Element {
  const update = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]): void => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="field-grid">
      <div className="field">
        <label htmlFor={`${idPrefix}-due`}>Due date and time</label>
        <input
          id={`${idPrefix}-due`}
          type="datetime-local"
          value={values.dueAt}
          onChange={(event) => {
            update('dueAt', event.target.value);
          }}
          aria-describedby={`${idPrefix}-due-hint`}
        />
        <p className="hint" id={`${idPrefix}-due-hint`}>
          In your own timezone. Leave empty for no deadline.
        </p>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-priority`}>Priority</label>
        <select
          id={`${idPrefix}-priority`}
          value={values.priority}
          onChange={(event) => {
            update('priority', event.target.value as TaskPriorityDto);
          }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-recurrence`}>Repeats</label>
        <select
          id={`${idPrefix}-recurrence`}
          value={values.recurrenceKind}
          onChange={(event) => {
            update('recurrenceKind', event.target.value as RecurrenceKind);
          }}
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="every">Every N days</option>
        </select>
      </div>

      {values.recurrenceKind === 'every' && (
        <div className="field">
          <label htmlFor={`${idPrefix}-every`}>Repeat every (days)</label>
          <input
            id={`${idPrefix}-every`}
            type="number"
            min={1}
            step={1}
            value={values.everyDays}
            onChange={(event) => {
              update('everyDays', event.target.value);
            }}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor={`${idPrefix}-offset`}>Remind me this many minutes before</label>
        <input
          id={`${idPrefix}-offset`}
          type="number"
          min={0}
          step={5}
          value={values.reminderOffsetMinutes}
          onChange={(event) => {
            update('reminderOffsetMinutes', event.target.value);
          }}
        />
      </div>

      <div className="field field--wide">
        <label htmlFor={`${idPrefix}-description`}>Description</label>
        <textarea
          id={`${idPrefix}-description`}
          rows={3}
          value={values.description}
          onChange={(event) => {
            update('description', event.target.value);
          }}
        />
      </div>
    </div>
  );
}

interface TaskEditFormProps {
  readonly values: TaskFormValues;
  readonly onChange: (values: TaskFormValues) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly idPrefix: string;
}

export function TaskEditForm({
  values,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
  idPrefix,
}: TaskEditFormProps): JSX.Element {
  const titleId = useId();
  const errorId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className="task-edit" onSubmit={handleSubmit} noValidate>
      {error !== null && (
        <p className="alert" role="alert" id={errorId}>
          {error}
        </p>
      )}

      <div className="field field--wide">
        <label htmlFor={titleId}>Title</label>
        <input
          id={titleId}
          type="text"
          value={values.title}
          onChange={(event) => {
            onChange({ ...values, title: event.target.value });
          }}
          required
          /* The edit form opens focused on its first field, so the keyboard
             lands where the work is. */
          autoFocus
          aria-describedby={error === null ? undefined : errorId}
        />
      </div>

      <TaskDetailFields values={values} onChange={onChange} idPrefix={idPrefix} />

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
