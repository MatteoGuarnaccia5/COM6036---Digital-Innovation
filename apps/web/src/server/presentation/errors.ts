/**
 * The one place in the application where an HTTP status code is chosen.
 *
 * Business logic raises domain errors that describe what went wrong in the
 * language of the problem; this translates them for the transport. That is what
 * lets `@tasks/core` be tested without a web framework, and it means a change
 * of status code is a one-file change.
 *
 * Note what is missing: there is no mapping to 403. A task belonging to another
 * user raises `TaskNotFoundError` and leaves as a 404, so the API cannot be used
 * to discover that another user's records exist.
 */
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  TaskNotFoundError,
  ValidationError,
} from '@tasks/core';
import type { ErrorRequestHandler, Request, Response } from 'express';
import { ZodError } from 'zod';

import type { ErrorResponseBody } from '../../shared/api-types.js';
import { InvalidLocalDateTimeError } from './timezone.js';
import { UnauthenticatedError } from './session.js';

interface Mapped {
  readonly status: number;
  readonly body: ErrorResponseBody;
}

function map(error: unknown): Mapped | null {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: { error: { message: error.message, ...(error.field !== undefined && { field: error.field }) } },
    };
  }

  if (error instanceof ZodError) {
    const first = error.issues[0];
    return {
      status: 400,
      body: {
        error: {
          message: first?.message ?? 'The request body is not valid',
          ...(first?.path[0] !== undefined && { field: String(first.path[0]) }),
        },
      },
    };
  }

  if (error instanceof InvalidLocalDateTimeError) {
    return { status: 400, body: { error: { message: error.message, field: 'dueAt' } } };
  }

  if (error instanceof UnauthenticatedError || error instanceof InvalidCredentialsError) {
    return { status: 401, body: { error: { message: error.message } } };
  }

  if (error instanceof EmailAlreadyRegisteredError) {
    return { status: 409, body: { error: { message: error.message, field: 'email' } } };
  }

  if (error instanceof TaskNotFoundError) {
    return { status: 404, body: { error: { message: error.message } } };
  }

  return null;
}

export const notFoundHandler = (_request: Request, response: Response): void => {
  response.status(404).json({ error: { message: 'Not found' } } satisfies ErrorResponseBody);
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const mapped = map(error);
  if (mapped !== null) {
    response.status(mapped.status).json(mapped.body);
    return;
  }

  /* Anything unrecognised is a bug. Log it in full, tell the client nothing:
     an internal message could disclose schema or filesystem detail. */
  console.error('[web] unhandled error', error);
  response
    .status(500)
    .json({ error: { message: 'Something went wrong' } } satisfies ErrorResponseBody);
};
