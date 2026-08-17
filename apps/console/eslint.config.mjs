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
    // A file-level 'use server' directive defines Server Functions. Keep it
    // limited to dedicated action modules so ordinary server code remains
    // safely importable by Server Components. This block must live in THIS
    // config file, not the root one: ESLint resolves the nearest config for
    // each linted file, and flat-config `files` patterns are relative to the
    // resolved config's own directory - a root-config
    // 'apps/console/src/**' pattern never matches from here (verified with a
    // deliberate violation in #third-pass; the registration had been inert).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@nx/workspace-use-server-actions-only': 'error',
    },
  },
  {
    ignores: ['.next/**/*'],
  },
];
