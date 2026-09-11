import { EmailAlreadyRegisteredError, type NewUser, type User, type UserRepository } from '@tasks/core';
import { eq } from 'drizzle-orm';

import type { DatabaseExecutor } from '../client.js';
import { users } from '../schema.js';
import { toUser } from './mappers.js';

/**
 * Addresses are stored and compared lowercased, so `Demo@Example.com` and
 * `demo@example.com` are one account rather than two.
 */
const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver faults in a `DrizzleQueryError` and puts the original
 * `pg` error on `cause`, so the Postgres error code has to be looked for at
 * both levels. Walking the chain rather than assuming a depth means an ORM
 * upgrade that changes the wrapping cannot silently turn a duplicate
 * registration back into a 500.
 */
function isDuplicateEmail(error: unknown): boolean {
  for (let current = error, depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;

    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === 'users_email_unique') {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createUserRepository(executor: DatabaseExecutor): UserRepository {
  return {
    async findById(userId: string): Promise<User | null> {
      const [row] = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
      return row === undefined ? null : toUser(row);
    },

    async findByEmail(email: string): Promise<User | null> {
      const [row] = await executor
        .select()
        .from(users)
        .where(eq(users.email, normaliseEmail(email)))
        .limit(1);
      return row === undefined ? null : toUser(row);
    },

    async create(input: NewUser): Promise<User> {
      try {
        const [row] = await executor
          .insert(users)
          .values({
            email: normaliseEmail(input.email),
            passwordHash: input.passwordHash,
            timezone: input.timezone,
          })
          .returning();

        if (row === undefined) throw new Error('Insert into users returned no row');
        return toUser(row);
      } catch (error) {
        /* The unique index is the authority on whether an address is taken,
           not an earlier read, so the race is resolved here. */
        if (isDuplicateEmail(error)) throw new EmailAlreadyRegisteredError();
        throw error;
      }
    },
  };
}
