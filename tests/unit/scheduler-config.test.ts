/**
 * The scheduler's environment parsing.
 *
 * This exists because of a specific defect. Docker Compose substitutes
 * `${SMTP_USER:-}` as an *empty string* rather than omitting the variable, so
 * a stack with no mail configured passes `SMTP_HOST=""`, `SMTP_USER=""` and
 * `SMTP_PASS=""` to the process. Code that only checked for `undefined` would
 * conclude that a mail server was configured and that it had credentials, then
 * attempt an SMTP AUTH with a blank username against a blank host.
 *
 * "Unset" and "set to nothing" have to mean the same thing, and that is worth a
 * test rather than a comment, because it is invisible in ordinary local use.
 */
import { loadConfig } from '@tasks/scheduler/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SMTP_KEYS = [
  'DATABASE_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'TICK_INTERVAL_MS',
  'REMINDER_BATCH_LIMIT',
  'REMINDER_MAX_ATTEMPTS',
] as const;

let saved: Record<string, string | undefined>;

const setEnv = (values: Record<string, string | undefined>): void => {
  for (const key of SMTP_KEYS) delete process.env[key];
  process.env['DATABASE_URL'] = 'postgres://tasks:tasks@localhost:5432/tasks';
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

beforeEach(() => {
  saved = Object.fromEntries(SMTP_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('choosing between SMTP and the stdout fallback', () => {
  it('falls back to stdout when SMTP_HOST is absent', () => {
    setEnv({});
    expect(loadConfig().smtp).toBeNull();
  });

  it('treats an empty SMTP_HOST exactly as an absent one', () => {
    /* What `docker compose up` with no .env actually passes. */
    setEnv({ SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });

    const config = loadConfig();
    expect(config.smtp).toBeNull();
    expect(config.mailFrom).toBe('tasks@localhost');
  });

  it('uses SMTP once a host is given', () => {
    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'tasks@example.com' });

    expect(loadConfig().smtp).toMatchObject({ host: 'smtp.example.com', port: 587 });
    expect(loadConfig().mailFrom).toBe('tasks@example.com');
  });
});

describe('credentials', () => {
  it('sends without authentication when neither user nor password is given', () => {
    setEnv({ SMTP_HOST: 'relay.internal' });
    expect(loadConfig().smtp?.auth).toBeNull();
  });

  it('sends without authentication when they are present but empty', () => {
    /* The defect: blank strings are not credentials. */
    setEnv({ SMTP_HOST: 'relay.internal', SMTP_USER: '', SMTP_PASS: '' });
    expect(loadConfig().smtp?.auth).toBeNull();
  });

  it('requires both halves before attempting authentication', () => {
    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com' });
    expect(loadConfig().smtp?.auth).toBeNull();

    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'secret' });
    expect(loadConfig().smtp?.auth).toBeNull();
  });

  it('authenticates when both are supplied', () => {
    setEnv({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'app-password' });

    expect(loadConfig().smtp?.auth).toEqual({ user: 'me@gmail.com', pass: 'app-password' });
  });

  it('trims surrounding whitespace, which a copied app password often carries', () => {
    setEnv({ SMTP_HOST: ' smtp.gmail.com ', SMTP_USER: ' me@gmail.com ', SMTP_PASS: ' secret ' });

    expect(loadConfig().smtp).toMatchObject({
      host: 'smtp.gmail.com',
      auth: { user: 'me@gmail.com', pass: 'secret' },
    });
  });
});

describe('transport security', () => {
  it('uses implicit TLS on 465 and STARTTLS elsewhere', () => {
    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465' });
    expect(loadConfig().smtp?.secure).toBe(true);

    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' });
    expect(loadConfig().smtp?.secure).toBe(false);

    setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '25' });
    expect(loadConfig().smtp?.secure).toBe(false);
  });
});

describe('the rest of the environment', () => {
  it('applies the documented defaults', () => {
    setEnv({});

    expect(loadConfig()).toMatchObject({
      tickIntervalMs: 60_000,
      batchLimit: 50,
      maxAttempts: 5,
      mailFrom: 'tasks@localhost',
    });
  });

  it('refuses to start without a database', () => {
    setEnv({});
    delete process.env['DATABASE_URL'];

    expect(() => loadConfig()).toThrow(/DATABASE_URL is required/);
  });

  it('rejects a nonsensical interval rather than silently ticking wrongly', () => {
    setEnv({ TICK_INTERVAL_MS: 'soon' });
    expect(() => loadConfig()).toThrow(/positive whole number/);

    setEnv({ TICK_INTERVAL_MS: '0' });
    expect(() => loadConfig()).toThrow(/positive whole number/);
  });
});
