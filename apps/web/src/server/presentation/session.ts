/**
 * Session handling - a presentation concern from end to end.
 *
 * Business logic answers "are these credentials good?"; deciding that the
 * answer should be remembered in a signed cookie, for how long, and under what
 * flags, happens here.
 */
import type { AuthService, User } from '@tasks/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

declare module 'express-session' {
  interface SessionData {
    /** The authenticated user's id. The only thing kept in the session. */
    userId?: string | undefined;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by {@link requireAuthentication}. */
    currentUser?: User | undefined;
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('You must be signed in');
    this.name = 'UnauthenticatedError';
  }
}

const promisify = (
  operation: (callback: (error?: unknown) => void) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    operation((error) => {
      if (error === undefined || error === null) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

/**
 * Starts an authenticated session.
 *
 * The session id is regenerated first. Without that, an attacker who can set a
 * victim's cookie before they sign in - session fixation - would still hold a
 * valid id afterwards. Regenerating means the id that gets the privileges is
 * one the server has just minted.
 */
export async function startSession(request: Request, user: User): Promise<void> {
  await promisify((done) => {
    request.session.regenerate(done);
  });
  request.session.userId = user.id;
  await promisify((done) => {
    request.session.save(done);
  });
}

export async function endSession(request: Request): Promise<void> {
  await promisify((done) => {
    request.session.destroy(done);
  });
}

/**
 * Rejects anonymous requests and loads the signed-in user onto the request.
 *
 * The user is re-read on every request rather than cached in the session, so
 * that a change of timezone - or a deleted account - takes effect immediately
 * instead of lingering until the cookie expires.
 */
export function requireAuthentication(authService: AuthService): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const userId = request.session.userId;
    if (userId === undefined) {
      next(new UnauthenticatedError());
      return;
    }

    authService
      .findById(userId)
      .then(async (user) => {
        if (user === null) {
          /* The session outlived the account it referred to. */
          await endSession(request);
          next(new UnauthenticatedError());
          return;
        }
        request.currentUser = user;
        next();
      })
      .catch(next);
  };
}

/**
 * The authenticated user, for handlers mounted behind
 * {@link requireAuthentication}. Throwing rather than asserting keeps the
 * handlers free of non-null assertions and turns a routing mistake into a
 * clear error instead of a crash on undefined.
 */
export function currentUser(request: Request): User {
  const user = request.currentUser;
  if (user === undefined) throw new UnauthenticatedError();
  return user;
}
