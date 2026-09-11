import type { PasswordHasher } from '@tasks/core';

/**
 * A hasher that does no cryptography.
 *
 * bcrypt at cost 10 takes roughly 70ms per call by design, which is correct in
 * production and ruinous in a unit suite. Substituting it here is the point of
 * the port. It also records its calls, which lets a test assert that a login
 * for an unknown address still performs a verification - the defence against
 * user enumeration by response time.
 */
export interface FakePasswordHasher extends PasswordHasher {
  readonly verifyCalls: { plainText: string; passwordHash: string }[];
}

export function createFakePasswordHasher(): FakePasswordHasher {
  const verifyCalls: { plainText: string; passwordHash: string }[] = [];

  return {
    verifyCalls,
    async hash(plainText: string): Promise<string> {
      return `hashed:${plainText}`;
    },
    async verify(plainText: string, passwordHash: string): Promise<boolean> {
      verifyCalls.push({ plainText, passwordHash });
      return passwordHash === `hashed:${plainText}`;
    },
  };
}
