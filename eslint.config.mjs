import markdown from '@eslint/markdown';
import nx from '@nx/eslint-plugin';
import jest from 'eslint-plugin-jest';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import jsoncParser from 'jsonc-eslint-parser';

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
              sourceTag: 'platform:shared',
              notDependOnLibsWithTags: ['platform:server', 'platform:browser'],
            },
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
    files: ['package.json'],
    ...nx.configs['flat/dependency-checks'],
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
