import { defineConfig } from 'drizzle-kit';

/**
 * Used only by `npm run db:generate -w @tasks/data`, which turns a change in
 * src/schema.ts into a checked-in SQL migration. Migrations are never
 * generated or pushed at runtime; containers only ever *apply* the SQL files in
 * ./migrations. See src/migrate.ts.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/session-schema.ts'],
  out: './migrations',
  strict: true,
  verbose: true,
});
