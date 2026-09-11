/**
 * FR2, FR3 and FR4 - the task list, with creation and editing inline.
 *
 * ## Two clicks to a new task
 *
 * The quick-add form is always on the page, already focusable, with its title
 * field first and its submit button next to it. Typing a title and pressing
 * "Add task" - or Enter - creates the task: one click, no navigation. The
 * "More options" disclosure adds a deadline, priority, recurrence and reminder
 * offset without leaving the list, which is the second click at most.
 *
 * ## Announcements
 *
 * Creating, completing and deleting all change the list without moving focus,
 * which a sighted user notices and a screen reader user does not. Each writes a
 * sentence into a polite live region instead, so the outcome is spoken.
 */
import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';

import type { TaskDto, UserDto } from '../../shared/api-types';
import { ApiError, api } from '../api';
import {
  TaskDetailFields,
  TaskEditForm,
  emptyTaskFormValues,
  formValuesToInput,
  taskToFormValues,
  type TaskFormValues,
} from './TaskForm';
import { TaskItem } from './TaskItem';

interface TaskListPageProps {
  readonly user: UserDto;
  readonly onSignedOut: () => void;
}

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong';

export function TaskListPage({ user, onSignedOut }: TaskListPageProps): JSX.Element {
  const [tasks, setTasks] = useState<readonly TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [newTask, setNewTask] = useState<TaskFormValues>(emptyTaskFormValues);
  const [showDetails, setShowDetails] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<TaskFormValues>(emptyTaskFormValues);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const newTitleId = useId();
  const detailsId = useId();
  const createErrorId = useId();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTasks(await api.listTasks());
      setListError(null);
    } catch (error) {
      setListError(describe(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setCreateError(null);

    try {
      const created = await api.createTask(formValuesToInput(newTask));
      setNewTask(emptyTaskFormValues);
      setShowDetails(false);
      await refresh();
      setAnnouncement(`Added “${created.title}”.`);
      /* Focus returns to the title field, ready for the next one. */
      titleInputRef.current?.focus();
    } catch (error) {
      setCreateError(describe(error));
    } finally {
      setCreating(false);
    }
  }

  async function handleComplete(task: TaskDto): Promise<void> {
    setSavingId(task.id);
    try {
      const result = await api.completeTask(task.id);
      await refresh();
      setAnnouncement(
        result.nextOccurrence === null
          ? `Completed “${task.title}”.`
          : `Completed “${task.title}”. Next occurrence due ${
              result.nextOccurrence.dueAt?.display ?? 'with no deadline'
            }.`,
      );
    } catch (error) {
      setListError(describe(error));
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(task: TaskDto): Promise<void> {
    /* A native confirm is keyboard accessible and focus-managed by the browser,
       which a hand-rolled modal would have to reimplement correctly. */
    if (!window.confirm(`Delete “${task.title}”? This cannot be undone.`)) return;

    setSavingId(task.id);
    try {
      await api.deleteTask(task.id);
      await refresh();
      setAnnouncement(`Deleted “${task.title}”.`);
    } catch (error) {
      setListError(describe(error));
    } finally {
      setSavingId(null);
    }
  }

  async function handleSaveEdit(): Promise<void> {
    if (editingId === null) return;

    setSavingId(editingId);
    setEditError(null);
    try {
      const updated = await api.updateTask(editingId, formValuesToInput(editValues));
      setEditingId(null);
      await refresh();
      setAnnouncement(`Saved “${updated.title}”.`);
    } catch (error) {
      setEditError(describe(error));
    } finally {
      setSavingId(null);
    }
  }

  async function handleSignOut(): Promise<void> {
    try {
      await api.logOut();
    } finally {
      onSignedOut();
    }
  }

  const openCount = tasks.filter((task) => task.status === 'open').length;

  return (
    <div className="page">
      <header className="page__header">
        <h1>Your tasks</h1>
        <div className="page__account">
          <span className="page__email">{user.email}</span>
          <button
            type="button"
            className="button button--link"
            onClick={() => {
              void handleSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main>
        {/* Announcements for actions that change the list without moving focus. */}
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        <section className="card" aria-labelledby="add-heading">
          <h2 id="add-heading">Add a task</h2>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
            noValidate
          >
            {createError !== null && (
              <p className="alert" role="alert" id={createErrorId}>
                {createError}
              </p>
            )}

            <div className="quick-add">
              <div className="field field--grow">
                <label htmlFor={newTitleId}>Task title</label>
                <input
                  id={newTitleId}
                  ref={titleInputRef}
                  type="text"
                  value={newTask.title}
                  onChange={(event) => {
                    setNewTask({ ...newTask, title: event.target.value });
                  }}
                  placeholder="e.g. Submit the literature review"
                  required
                  aria-describedby={createError === null ? undefined : createErrorId}
                />
              </div>

              <button type="submit" className="button button--primary" disabled={creating}>
                {creating ? 'Adding…' : 'Add task'}
              </button>

              <button
                type="button"
                className="button"
                aria-expanded={showDetails}
                aria-controls={detailsId}
                onClick={() => {
                  setShowDetails(!showDetails);
                }}
              >
                {showDetails ? 'Fewer options' : 'More options'}
              </button>
            </div>

            <div id={detailsId} hidden={!showDetails}>
              <TaskDetailFields values={newTask} onChange={setNewTask} idPrefix="new-task" />
            </div>
          </form>
        </section>

        <section aria-labelledby="list-heading">
          <h2 id="list-heading">
            {openCount === 1 ? '1 task outstanding' : `${String(openCount)} tasks outstanding`}
          </h2>

          {listError !== null && (
            <p className="alert" role="alert">
              {listError}
            </p>
          )}

          {loading ? (
            <p role="status">Loading your tasks…</p>
          ) : tasks.length === 0 ? (
            <p className="empty">Nothing here yet. Add your first task above.</p>
          ) : (
            <ul className="task-list">
              {tasks.map((task) =>
                editingId === task.id ? (
                  <li key={task.id} className="task task--editing">
                    <h3 className="visually-hidden">Editing “{task.title}”</h3>
                    <TaskEditForm
                      values={editValues}
                      onChange={setEditValues}
                      onSubmit={() => {
                        void handleSaveEdit();
                      }}
                      onCancel={() => {
                        setEditingId(null);
                        setEditError(null);
                      }}
                      busy={savingId === task.id}
                      error={editError}
                      idPrefix={`edit-${task.id}`}
                    />
                  </li>
                ) : (
                  <TaskItem
                    key={task.id}
                    task={task}
                    busy={savingId === task.id}
                    onEdit={(selected) => {
                      setEditingId(selected.id);
                      setEditValues(taskToFormValues(selected));
                      setEditError(null);
                    }}
                    onComplete={(selected) => {
                      void handleComplete(selected);
                    }}
                    onDelete={(selected) => {
                      void handleDelete(selected);
                    }}
                  />
                ),
              )}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
