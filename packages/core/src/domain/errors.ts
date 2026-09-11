/**
 * Domain errors.
 *
 * Business logic signals failure with these; the presentation layer decides
 * what they mean over HTTP. That split is why `core` can be tested without a
 * web framework, and why status codes appear in exactly one place.
 *
 * Note the deliberate absence of an "access denied" error. A task belonging to
 * another user is reported as {@link TaskNotFoundError}, never as a forbidden
 * one, so the API cannot be used to discover that another user's record exists.
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A request that is well-formed but violates a business rule. */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    /** The offending field, when the failure can be attributed to one. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * The task does not exist, or it exists and belongs to somebody else. The two
 * cases are deliberately indistinguishable.
 */
export class TaskNotFoundError extends DomainError {
  constructor() {
    super('Task not found');
  }
}

export class EmailAlreadyRegisteredError extends DomainError {
  constructor() {
    super('That email address is already registered');
  }
}

/** Raised for both an unknown email and a wrong password, without distinction. */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('Incorrect email or password');
  }
}
