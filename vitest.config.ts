import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    /* Tests run against workspace *source*, not build output, so a failing test
       points at a line you can edit and coverage maps to real files. */
    alias: [
      { find: /^@tasks\/core$/, replacement: fromRoot('./packages/core/src/index.ts') },
      { find: /^@tasks\/data$/, replacement: fromRoot('./packages/data/src/index.ts') },
      /* The integration suite reaches into the web app's presentation layer;
         anchored patterns keep `@tasks/web` and `@tasks/web/x` distinct. */
      { find: /^@tasks\/web$/, replacement: fromRoot('./apps/web/src/server/app.ts') },
      { find: /^@tasks\/web\/(.*)$/, replacement: `${fromRoot('./apps/web/src/server')}/$1.ts` },
      /* No bare `@tasks/scheduler` alias on purpose: its entry point starts the
         tick loop, so tests address its modules individually. */
      { find: /^@tasks\/scheduler\/(.*)$/, replacement: `${fromRoot('./apps/scheduler/src')}/$1.ts` },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /* Integration and scheduler suites share one throwaway Postgres database,
       so they must not interleave. Unit suites are unaffected by this. */
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts'],
    },
  },
});
