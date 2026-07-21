import markdown from '@eslint/markdown';
import nx from '@nx/eslint-plugin';
import jest from 'eslint-plugin-jest';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import * as jsoncParser from 'jsonc-eslint-parser';


export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/next-env.d.ts',
      '**/test-output',
      'conductor/',
      '.agent/',
      '.gemini/',
      '.jules/',
      '.worktrees/',
      '**/vitest.config.*.timestamp*',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'platform:server',
              notDependOnLibsWithTags: ['platform:browser'],
            },
            {
              sourceTag: 'platform:browser',
              notDependOnLibsWithTags: ['platform:server'],
            },
            {
              sourceTag: 'platform:nextjs',
              notDependOnLibsWithTags: [],
            },
            {
              sourceTag: 'platform:shared',
              notDependOnLibsWithTags: ['platform:browser'],
            },
            // scope:* dimension (#2793 follow-through): stops app-domain
            // coupling at the import site instead of discovering it later as
            // a phantom Nx-affected edge (libs/app importing @repo/races made
            // every onecake E2E lane run — and fail — on primes-only PRs).
            // `scope:shared` is the chassis + generic integrations: it may
            // never import domain code. `scope:chassis` is the four libs that
            // still hold cross-domain imports (app, chores, export-sheets,
            // strava) — permissive until each #2798-style extraction lands;
            // do NOT add new projects to it. Racing (members+primes) and
            // onecake domains may never import each other. Members apps span
            // both domains by design (Slack club hub); primes/onecake apps
            // are locked to their own.
            {
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:chassis'],
            },
            {
              sourceTag: 'scope:racing',
              onlyDependOnLibsWithTags: [
                'scope:racing',
                'scope:shared',
                'scope:chassis',
              ],
            },
            {
              sourceTag: 'scope:onecake',
              onlyDependOnLibsWithTags: [
                'scope:onecake',
                'scope:shared',
                'scope:chassis',
              ],
            },
            {
              sourceTag: 'scope:primes',
              onlyDependOnLibsWithTags: [
                'scope:racing',
                'scope:shared',
                'scope:chassis',
              ],
            },
            {
              sourceTag: 'scope:agent-console',
              onlyDependOnLibsWithTags: ['scope:shared', 'scope:chassis'],
            },
            // scope:members, scope:tooling, scope:chassis: deliberately
            // unconstrained (members legitimately imports both domains;
            // cli/agent are cross-cutting admin tooling; chassis is the
            // tracked debt above).
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'Using require() is not allowed. Use ES static imports instead.',
        },
        {
          selector: 'ImportExpression',
          message:
            'Dynamic import() is not allowed. Use ES static imports instead.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]',
          message:
            "Bare toLocale*String() depends on the runtime locale/timezone and causes hydration mismatches (React #418). Pin them (e.g. 'en-US', { timeZone: 'UTC' }) or use the date helpers in @repo/util.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='Identifier'][arguments.0.name='undefined']",
          message:
            "toLocale*String(undefined, …) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale (e.g. 'en-US') and include a timeZone, or use the date helpers in @repo/util.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.0.type='ArrayExpression'][arguments.0.elements.length=0]",
          message:
            "toLocale*String([], …) uses the runtime locale and causes hydration mismatches (React #418). Pin the locale (e.g. 'en-US') and include a timeZone, or use the date helpers in @repo/util.",
        },
      ],
    },
  },
  // unusedImports: Start
  // Overriding teslint no-unsed-vars rule.
  // Per: https://www.npmjs.com/package/eslint-plugin-unused-imports
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'warn',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          // Options based on https://typescript-eslint.io/rules/no-unused-vars/
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // unusedImports: End

  // Tests
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    plugins: {
      jest,
    },
    rules: {
      ...jest.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Tests: End

  // package.json dependency checks
  {
    files: ['**/package.json'],
    ...nx.configs['flat/dependency-checks'],
    rules: {
      '@nx/dependency-checks': 'off',
    },
  },

  {
    files: ['**/*.json'],
    languageOptions: {
      parser: jsoncParser,
    },
  },

  {
    files: ['**/*.md'],
    plugins: {
      markdown,
    },
    language: 'markdown/commonmark',
    rules: {},
  },

  // E2E fixture/seed clock guardrail (#2710/#2741, PR #2765): seed data and
  // mock-db fixtures must not be computed from the wall clock. Specs pin the
  // page clock via `?e2eNow=`; a `Date.now()`-relative fixture drifts
  // against that pinned now until assertions (or visual baselines) break —
  // a time bomb that detonates days or months after it's introduced. Pin
  // fixture instants to constants (see `MOCK_CALENDAR_E2E_NOW` in
  // libs/races/src/mock-db.ts and `SEED_REFERENCE_NOW` in the primes
  // seed-feed-events route). If a wall-clock value is genuinely safe (the
  // consuming spec does NOT pin e2eNow, or the value is a uniqueness
  // suffix), disable per-line with the reason.
  {
    // NOTE: every app/lib has its own eslint.config.mjs spreading this one,
    // so these globs are matched relative to THAT nested config's directory
    // (its flat-config basePath), not the repo root — they must stay
    // basePath-agnostic (`**/`-prefixed, no `apps/*/...` anchors).
    files: [
      '**/mock-db.ts',
      '**/app/api/e2e/**/*.ts',
      '**/src/**/seed*.ts',
      '**/src/**/*-seed.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Wall-clock Date.now() in e2e fixtures/seeds drifts against specs’ pinned ?e2eNow= (#2710/#2741). Pin the instant to a constant, or eslint-disable this line with the reason it is safe.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Wall-clock new Date() in e2e fixtures/seeds drifts against specs’ pinned ?e2eNow= (#2710/#2741). Pin the instant to a constant, or eslint-disable this line with the reason it is safe.',
        },
      ],
    },
  },

  // Override or add rules here
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {},
  },
];
