/**
 * Unit tests for FR1. No database, no HTTP, no bcrypt - registration and login
 * rules are business logic, and the hashing is a port.
 */
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  MIN_PASSWORD_LENGTH,
  ValidationError,
  createAuthService,
  type AuthService,
} from '@tasks/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../support/fakes/fake-clock.js';
import {
  createFakePasswordHasher,
  type FakePasswordHasher,
} from '../support/fakes/fake-password-hasher.js';
import {
  createInMemoryBackend,
  type InMemoryBackend,
} from '../support/fakes/in-memory-repositories.js';

let backend: InMemoryBackend;
let passwordHasher: FakePasswordHasher;
let authService: AuthService;

const CREDENTIALS = {
  email: 'demo@example.com',
  password: 'correct-horse',
  timezone: 'Europe/London',
} as const;

beforeEach(() => {
  backend = createInMemoryBackend(createFakeClock(new Date('2026-05-04T10:00:00.000Z')));
  passwordHasher = createFakePasswordHasher();
  authService = createAuthService({ unitOfWork: backend.unitOfWork, passwordHasher });
});

describe('registration', () => {
  it('stores what the hasher produced, not the password it was given', async () => {
    const user = await authService.register(CREDENTIALS);

    /* The fake's output is recognisable rather than secret - proving the value
       is unguessable is bcrypt's job, and is asserted against the real adapter
       in tests/integration/auth.test.ts. What matters here is that the stored
       value came from the port and was not the raw password passed through. */
    expect(user.passwordHash).toBe(`hashed:${CREDENTIALS.password}`);
    expect(user.passwordHash).not.toBe(CREDENTIALS.password);
    expect(user.email).toBe('demo@example.com');
    expect(user.timezone).toBe('Europe/London');
  });

  it('rejects a second registration of the same address, whatever the case', async () => {
    await authService.register(CREDENTIALS);

    await expect(
      authService.register({ ...CREDENTIALS, email: 'DEMO@Example.com' }),
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    expect(backend.store.users.size).toBe(1);
  });

  it('rejects an address that is obviously not one', async () => {
    for (const email of ['', 'nope', 'no@domain', 'two words@example.com', 'a@b@example.com']) {
      await expect(authService.register({ ...CREDENTIALS, email })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it(`requires a password of at least ${String(MIN_PASSWORD_LENGTH)} characters`, async () => {
    await expect(
      authService.register({ ...CREDENTIALS, password: 'short' }),
    ).rejects.toThrow(/at least 8 characters/i);
  });

  it('rejects an absurdly long password rather than hashing it', async () => {
    await expect(
      authService.register({ ...CREDENTIALS, password: 'x'.repeat(5000) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires a timezone', async () => {
    await expect(authService.register({ ...CREDENTIALS, timezone: '   ' })).rejects.toThrow(
      /timezone is required/i,
    );
  });
});

describe('login', () => {
  beforeEach(async () => {
    await authService.register(CREDENTIALS);
  });

  it('returns the user for correct credentials', async () => {
    const user = await authService.login(CREDENTIALS.email, CREDENTIALS.password);
    expect(user.email).toBe('demo@example.com');
  });

  it('accepts the address in any case', async () => {
    const user = await authService.login('DEMO@EXAMPLE.COM', CREDENTIALS.password);
    expect(user.email).toBe('demo@example.com');
  });

  it('rejects a wrong password', async () => {
    await expect(authService.login(CREDENTIALS.email, 'wrong-password')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('reports an unknown address exactly as it reports a wrong password', async () => {
    const unknown = await authService
      .login('nobody@example.com', CREDENTIALS.password)
      .catch((error: unknown) => error);
    const wrongPassword = await authService
      .login(CREDENTIALS.email, 'wrong-password')
      .catch((error: unknown) => error);

    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect(wrongPassword).toBeInstanceOf(InvalidCredentialsError);
    expect((unknown as Error).message).toBe((wrongPassword as Error).message);
  });

  it('still performs a verification for an unknown address', async () => {
    /* Otherwise the response time answers "is this address registered?" - the
       reason auth-service.ts carries a fixed hash to compare against. */
    passwordHasher.verifyCalls.length = 0;

    await authService.login('nobody@example.com', CREDENTIALS.password).catch(() => undefined);

    expect(passwordHasher.verifyCalls).toHaveLength(1);
    expect(passwordHasher.verifyCalls[0]?.passwordHash).toMatch(/^\$2[aby]\$/);
  });
});

describe('rehydrating a session', () => {
  it('finds the user behind an id, and nothing behind an unknown one', async () => {
    const registered = await authService.register(CREDENTIALS);

    await expect(authService.findById(registered.id)).resolves.toMatchObject({
      id: registered.id,
    });
    await expect(
      authService.findById('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });
});
