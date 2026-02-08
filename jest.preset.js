/* eslint-disable @typescript-eslint/no-require-imports */
const nxPreset = require('@nx/jest/preset').default;
const path = require('path');

module.exports = {
  ...nxPreset,
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  moduleNameMapper: {
    'server-only': path.join(
      __dirname,
      'libs/shared/src/test-utils/server-only-mock.js',
    ),
  },
};
