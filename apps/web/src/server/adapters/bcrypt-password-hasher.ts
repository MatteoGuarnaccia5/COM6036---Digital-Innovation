/**
 * The bcrypt adapter for the {@link PasswordHasher} port.
 *
 * bcrypt appears here, in the composition root, and nowhere else. The business
 * logic layer names only the interface, which is what lets its registration and
 * login rules be tested without a native module and keeps its package.json
 * dependency list empty.
 */
import type { PasswordHasher } from '@tasks/core';
import bcrypt from 'bcrypt';

/** Cost factor. Each increment doubles the work; 10 is the assessment's figure. */
export const BCRYPT_COST_FACTOR = 10;

export function createBcryptPasswordHasher(costFactor = BCRYPT_COST_FACTOR): PasswordHasher {
  return {
    async hash(plainText: string): Promise<string> {
      return bcrypt.hash(plainText, costFactor);
    },

    async verify(plainText: string, passwordHash: string): Promise<boolean> {
      try {
        return await bcrypt.compare(plainText, passwordHash);
      } catch {
        /* A malformed or truncated hash is a failed comparison, not a crash:
           one corrupt row should not turn a login attempt into a 500. */
        return false;
      }
    },
  };
}
