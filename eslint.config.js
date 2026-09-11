import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import layerRules from './tools/layer-rules.json' with { type: 'json' };

/**
 * Layer enforcement, mechanism 2 of 3.
 *
 * 1. `tsc --build` project references make an upward import a compile error.
 * 2. This config turns a forbidden import into a lint error, so CI fails fast.
 * 3. tests/architecture.test.ts asserts the same rules at test time and is the
 *    artefact cited in the report.
 *
 * All three read the boundaries from tools/layer-rules.json.
 */
const layerBoundaryConfigs = layerRules.rules.map((rule) => ({
  files: [`${rule.path}/**/*.ts`, `${rule.path}/**/*.tsx`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: rule.forbidden.flatMap((name) => [name, `${name}/*`]),
            message: rule.message,
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      /* Vite's output and the client project's typecheck-only emit. Both are
         build artefacts; linting them reports errors against generated code. */
      '**/dist-client/**',
      '**/dist-tsc/**',
      '**/coverage/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /* Plain-JavaScript tooling: config files and the accessibility audit.
       TypeScript files do not need this - typescript-eslint disables `no-undef`
       for them, because the compiler already knows what exists. */
    files: ['**/*.mjs', '*.js', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  ...layerBoundaryConfigs,
);
