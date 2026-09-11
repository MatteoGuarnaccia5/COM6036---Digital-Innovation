/**
 * FR1 - registration, login, and the rules around them.
 *
 * Hashing happens through the {@link PasswordHasher} port, so this file names
 * no cryptographic library and the business logic layer keeps its empty
 * dependency list. The composition root supplies bcrypt.
 *
 * Nothing here knows what a session is. Issuing, storing and expiring the
 * session cookie is the presentation layer's job; this service only answers
 * "are these credentials good, and who do they belong to?".
 */
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  ValidationError,
} from '../domain/errors.js';
import type { User } from '../domain/types.js';
import type { UnitOfWork } from '../ports/repositories.js';
import type { PasswordHasher } from '../ports/services.js';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately permissive. The only address that truly validates is one that
 * receives mail, and over-strict patterns reject real addresses; this rules out
 * the obviously malformed and leaves the rest to delivery.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * A real bcrypt hash of a random string, which nothing will ever match.
 *
 * Logging in with an unknown address verifies against this instead of
 * returning early, so a failed login costs the same work whether or not the
 * account exists. Without it, response time answers the question "is this
 * person registered here?" - a user-enumeration oracle. It is a hash of random
 * bytes, not of any real password, and it is only ever used as a comparison
 * target.
 */
const TIMING_EQUALISATION_HASH =
  '$2b$10$9CHx5sEY78AP9qi1qGLynuNlxYMwiBoaBxof0gD65icYfyGIvFE9W';

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  /**
   * IANA zone name, already validated by the presentation layer - the only
   * layer that interprets timezones. Carried here as an opaque string.
   */
  readonly timezone: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<User>;
  /** @throws {InvalidCredentialsError} for a wrong password *or* unknown address. */
  login(email: string, password: string): Promise<User>;
  /** Used to rehydrate the user behind a session cookie. */
  findById(userId: string): Promise<User | null>;
}

export interface AuthServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
}

function validateCredentials(email: string, password: string): void {
  const trimmed = email.trim();

  if (trimmed.length === 0) {
    throw new ValidationError('An email address is required', 'email');
  }
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    throw new ValidationError('That email address is too long', 'email');
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new ValidationError('That does not look like an email address', 'email');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `A password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
      'password',
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    /* bcrypt truncates beyond 72 bytes; rejecting absurd input also keeps a
       very long password from becoming a cheap way to burn CPU. */
    throw new ValidationError('That password is too long', 'password');
  }
}

export function createAuthService(dependencies: AuthServiceDependencies): AuthService {
  const { unitOfWork, passwordHasher } = dependencies;

  return {
    async register(input: RegisterInput): Promise<User> {
      validateCredentials(input.email, input.password);

      if (input.timezone.trim().length === 0) {
        throw new ValidationError('A timezone is required', 'timezone');
      }

      const passwordHash = await passwordHasher.hash(input.password);

      return unitOfWork.run(async (repositories) => {
        /*
         * The read is a courtesy that produces a clear error on the common
         * path; the unique index behind `create` is what actually guarantees
         * uniqueness, and it throws the same error if two registrations race.
         */
        const existing = await repositories.users.findByEmail(input.email);
        if (existing !== null) throw new EmailAlreadyRegisteredError();

        return repositories.users.create({
          email: input.email,
          passwordHash,
          timezone: input.timezone.trim(),
        });
      });
    },

    async login(email: string, password: string): Promise<User> {
      return unitOfWork.run(async (repositories) => {
        const user = await repositories.users.findByEmail(email);

        /* Same work either way - see TIMING_EQUALISATION_HASH. */
        const passwordHash = user?.passwordHash ?? TIMING_EQUALISATION_HASH;
        const matches = await passwordHasher.verify(password, passwordHash);

        /* One error for both cases, so the response cannot be used to discover
           which addresses are registered. */
        if (user === null || !matches) throw new InvalidCredentialsError();

        return user;
      });
    },

    async findById(userId: string): Promise<User | null> {
      return unitOfWork.run(async (repositories) => repositories.users.findById(userId));
    },
  };
}
