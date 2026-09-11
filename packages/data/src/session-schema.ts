/**
 * Session storage - infrastructure, not application data.
 *
 * `express-session` with `connect-pg-simple` needs a table of its own so that
 * logins survive a `web` container restart. It is kept in a separate file, and
 * out of the drizzle `Database` type, to make the distinction explicit: the
 * application's data model is the three tables in schema.ts, and no repository
 * or business rule ever reads or writes this one. The session store owns it.
 *
 * It is declared here rather than left to `connect-pg-simple`'s
 * `createTableIfMissing` option so that the DDL is a checked-in migration like
 * everything else, applied once at start-up under the same advisory lock.
 */
import { index, json, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const sessions = pgTable(
  'session',
  {
    sid: varchar('sid').primaryKey(),
    sess: json('sess').notNull(),
    /* timestamptz, unlike connect-pg-simple's stock DDL, so that this table
       obeys the same UTC rule as the rest of the schema. The store only ever
       compares it against `now()` and writes a JS Date, both of which behave
       correctly with a zone-aware column. */
    expire: timestamp('expire', { withTimezone: true, precision: 6, mode: 'date' }).notNull(),
  },
  (table) => [index('session_expire_idx').on(table.expire)],
);
