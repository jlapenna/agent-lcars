import * as jsoncParser from 'jsonc-eslint-parser';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': 'off',
    },
    languageOptions: {
      parser: jsoncParser,
    },
  },
];
