/**
 * The scheduler's environment, read once at start-up.
 *
 * Note what is absent: there is no web application URL, no API token, and no
 * shared secret. The scheduler does not talk to the web process at all - it
 * reads and writes the database through the same data access layer, which is
 * what makes its lifecycle genuinely independent.
 */

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth: { readonly user: string; readonly pass: string } | null;
}

export interface SchedulerConfig {
  readonly databaseUrl: string;
  readonly tickIntervalMs: number;
  readonly batchLimit: number;
  readonly maxAttempts: number;
  /** Null means print reminders to stdout instead of sending them. */
  readonly smtp: SmtpSettings | null;
  readonly mailFrom: string;
}

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(): SchedulerConfig {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }

  /*
   * An empty value means "not set". Docker Compose passes `${SMTP_USER:-}`
   * through as an empty string rather than omitting the variable, so treating
   * empty and undefined differently would make an unconfigured stack attempt
   * an SMTP AUTH with blank credentials.
   */
  const readOptional = (name: string): string | null => {
    const raw = process.env[name];
    return raw === undefined || raw.trim() === '' ? null : raw.trim();
  };

  const host = readOptional('SMTP_HOST');
  const user = readOptional('SMTP_USER');
  const pass = readOptional('SMTP_PASS');
  const port = readInteger('SMTP_PORT', 587);

  /*
   * SMTP_HOST is the switch. With it set, mail is sent for real; without it,
   * every reminder is printed to stdout in full. That is what lets
   * `docker compose up` demonstrate working delivery on a clean machine with no
   * credentials, while a real deployment only has to set five variables.
   */
  const smtp: SmtpSettings | null =
    host === null
      ? null
      : {
          host,
          port,
          /* Implicit TLS on 465; STARTTLS is negotiated on the others. */
          secure: port === 465,
          /* Both or neither: a relay on a trusted network needs no credentials. */
          auth: user !== null && pass !== null ? { user, pass } : null,
        };

  return {
    databaseUrl,
    tickIntervalMs: readInteger('TICK_INTERVAL_MS', 60_000),
    batchLimit: readInteger('REMINDER_BATCH_LIMIT', 50),
    maxAttempts: readInteger('REMINDER_MAX_ATTEMPTS', 5),
    smtp,
    mailFrom: readOptional('SMTP_FROM') ?? 'tasks@localhost',
  };
}
