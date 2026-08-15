import eslintReact from '@eslint-react/eslint-plugin';
import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

import baseConfig from '../../eslint.config.mjs';

export default [
  { plugins: { '@next/next': nextEslintPluginNext } },
  eslintReact.configs.jsx,
  eslintReact.configs.rsc,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y },
    settings: { react: { version: 'detect' } },
    rules: {
      ...jsxA11y.configs.recommended.rules,
    },
  },
  ...nx.configs['flat/react-typescript'],
  ...baseConfig,
  {
    files: ['**/src/lib/hosted-lifecycle/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@agent-lcars/lifecycle-control-plane/*',
                '**/lifecycle-control-plane/**',
              ],
              message:
                'Hosted lifecycle code must import lifecycle contracts through the package root.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['.next/**/*'],
  },
];
