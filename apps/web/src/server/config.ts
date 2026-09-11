/**
 * Environment configuration, read once and validated at start-up.
 *
 * Reading `process.env` here and nowhere else means a missing variable is a
 * clear failure on boot rather than an `undefined` surfacing in a request three
 * hours later.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEVELOPMENT_SESSION_SECRET = 'dev-secret-do-not-use-in-production';

export interface WebConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly seedOnStart: boolean;
  readonly isProduction: boolean;
  /** Absolute path to the built React client, or null when it has not been built. */
  readonly clientDistPath: string | null;
}

/**
 * Where Vite puts the built client.
 *
 * `src/server/config.ts` and `dist/server/config.js` are both two levels below
 * the package root, so this resolves to `apps/web/dist-client` whether the code
 * is running from source or from build output. Null when the client has not
 * been built, which is what the integration suite and `vite dev` both want.
 */
function locateClientDist(): string | null {
  const candidate = fileURLToPath(new URL('../../dist-client', import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const sessionSecret = process.env['SESSION_SECRET'] ?? DEVELOPMENT_SESSION_SECRET;

  if (isProduction && sessionSecret === DEVELOPMENT_SESSION_SECRET) {
    /* Not fatal: `docker compose up` is required to work with no setup, and it
       ships this value deliberately. Loud, though, because a predictable
       signing key means forgeable session cookies. */
    console.warn(
      '[web] SESSION_SECRET is the development default. Set a random value before exposing this to a network.',
    );
  }

  return {
    port: Number(process.env['PORT'] ?? 3000),
    databaseUrl,
    sessionSecret,
    /*
     * Off unless asked for. A Secure cookie is not sent over plain HTTP, so
     * defaulting this to on in production would break the documented
     * `docker compose up` on http://localhost - the browser would accept the
     * login response and then never send the cookie back.
     */
    secureCookies: readBoolean('SECURE_COOKIES', false),
    seedOnStart: readBoolean('SEED_ON_START', true),
    isProduction,
    clientDistPath: locateClientDist(),
    ...overrides,
  };
}
