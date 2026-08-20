import markdown from '@eslint/markdown';
import { fleetBaseline, fleetEslintPlugin } from '@jlapenna/repo-tools/eslint';
import nx from '@nx/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
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
      '**/coverage',
      '**/out-tsc',
      '**/next-env.d.ts',
      '**/test-output',
      '.agent/',
      '.gemini/',
      '.jules/',
      '.worktrees/',
      '**/vitest.config.*.timestamp*',
    ],
  },
  // Import-order, unused-symbol, and restricted-syntax hygiene for this
  // repository. Shared fleet lint behavior must use a shared artifact, not a
  // synchronized source file.
  ...fleetBaseline({ simpleImportSort, unusedImports }),
  {
    files: ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
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
              sourceTag: 'platform:shared',
              notDependOnLibsWithTags: ['platform:browser'],
            },
            {
              sourceTag: 'scope:shared',
              onlyDependOnLibsWithTags: ['scope:shared'],
            },
            {
              sourceTag: 'scope:console',
              onlyDependOnLibsWithTags: ['scope:console', 'scope:shared'],
            },
          ],
        },
      ],
    },
  },
  {
    // Nx workspace rule (#537/#566): a 'use client' file must not value-import
    // a server-only module. Tooling projects do not participate in the Next.js
    // graph and may load ESLint before workspace rules are registered.
    files: ['**/*.{ts,tsx}'],
    ignores: ['tools/**/*'],
    plugins: { fleet: fleetEslintPlugin },
    rules: {
      'fleet/no-server-only-imports-in-client': 'error',
    },
  },
  {
    files: ['**/*.{spec,test}.{ts,tsx,js,jsx,mts,mjs}'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-disabled-tests': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/vitest.config.mts'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
  {
    files: ['**/*.json'],
    languageOptions: { parser: jsoncParser },
  },
  {
    files: ['**/*.md'],
    plugins: { markdown },
    language: 'markdown/commonmark',
    rules: {},
  },
];
