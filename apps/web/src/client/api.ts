/**
 * The typed HTTP client.
 *
 * Every network call in the application goes through `send`, so the handling of
 * a failed response - and of the 401 that means "your session ended" - exists
 * once. The response types come from ../shared/api-types, the same declarations
 * the Express handlers serialise to, so a change on the server that this client
 * has not caught up with fails the typecheck.
 *
 * No `credentials` option is set anywhere: the client is served by the same
 * Express app that owns the API, so the session cookie is same-origin and is
 * sent by default. That is the whole reason the app serves its own static
 * files.
 */
import type {
  CompleteTaskResponseBody,
  ErrorResponseBody,
  TaskDto,
  TaskListResponseBody,
  TaskPriorityDto,
  TaskResponseBody,
  UserDto,
  UserResponseBody,
} from '../shared/api-types';

const API_ROOT = '/api/v1';

/** A failure the server described. `field` names the offending input, if any. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isErrorBody(value: unknown): value is ErrorResponseBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ErrorResponseBody).error?.message === 'string'
  );
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch {
    /* fetch only rejects for a transport failure, which is worth distinguishing
       from a server that answered with an error. */
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = isErrorBody(body) ? body.error.message : 'Something went wrong';
    const field = isErrorBody(body) ? body.error.field : undefined;
    throw new ApiError(message, response.status, field);
  }

  return body as T;
}

const jsonBody = (payload: unknown): RequestInit => ({ body: JSON.stringify(payload) });

/** What the create and edit forms produce. A naive local time, per the API. */
export interface TaskInput {
  readonly title: string;
  readonly description: string | null;
  /** `YYYY-MM-DDTHH:mm` in the user's own zone, or null for no deadline. */
  readonly dueAt: string | null;
  readonly priority: TaskPriorityDto;
  readonly recurrence: string | null;
  readonly reminderOffsetMinutes: number;
}

export const api = {
  async currentUser(): Promise<UserDto | null> {
    try {
      const body = await send<UserResponseBody>('/auth/me');
      return body.user;
    } catch (error) {
      /* Not signed in is an ordinary state, not an error worth showing. */
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },

  async register(email: string, password: string, timezone: string): Promise<UserDto> {
    const body = await send<UserResponseBody>('/auth/register', {
      method: 'POST',
      ...jsonBody({ email, password, timezone }),
    });
    return body.user;
  },

  async logIn(email: string, password: string): Promise<UserDto> {
    const body = await send<UserResponseBody>('/auth/login', {
      method: 'POST',
      ...jsonBody({ email, password }),
    });
    return body.user;
  },

  async logOut(): Promise<void> {
    await send<void>('/auth/logout', { method: 'POST' });
  },

  async listTasks(): Promise<readonly TaskDto[]> {
    const body = await send<TaskListResponseBody>('/tasks');
    return body.tasks;
  },

  async createTask(input: TaskInput): Promise<TaskDto> {
    const body = await send<TaskResponseBody>('/tasks', { method: 'POST', ...jsonBody(input) });
    return body.task;
  },

  async updateTask(id: string, input: TaskInput): Promise<TaskDto> {
    const body = await send<TaskResponseBody>(`/tasks/${id}`, {
      method: 'PATCH',
      ...jsonBody(input),
    });
    return body.task;
  },

  async completeTask(id: string): Promise<CompleteTaskResponseBody> {
    return send<CompleteTaskResponseBody>(`/tasks/${id}/complete`, { method: 'POST' });
  },

  async deleteTask(id: string): Promise<void> {
    await send<void>(`/tasks/${id}`, { method: 'DELETE' });
  },
};
