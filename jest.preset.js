/* eslint-disable no-restricted-syntax */
const nxPreset = require('@nx/jest/preset').default;
const path = require('path');

module.exports = {
  ...nxPreset,
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!.*(?:uuid|cls-rtracer|md-to-slack|marked|p-limit|yocto-queue|p-wait-for|p-timeout))',
  ],
  moduleNameMapper: {
    'server-only': path.join(
      __dirname,
      'libs/test-utils/src/server-only-mock.js',
    ),
    '^uuid$': require.resolve('uuid'),
    '^@members/auth/(.*)$': path.join(__dirname, 'libs/auth/src/$1'),
    '^@members/firebase-server$': path.join(
      __dirname,
      'libs/firebase-server/src/index.ts',
    ),
    '^@members/firebase-server/(.*)$': path.join(
      __dirname,
      'libs/firebase-server/src/$1',
    ),
    '^@members/instagram$': path.join(__dirname, 'libs/instagram/src/index.ts'),
    '^@members/instagram/(.*)$': path.join(__dirname, 'libs/instagram/src/$1'),
    '^@members/qbp$': path.join(__dirname, 'libs/qbp/src/index.ts'),
    '^@members/qbp/(.*)$': path.join(__dirname, 'libs/qbp/src/$1'),
    '^@members/competitions$': path.join(
      __dirname,
      'libs/competitions/src/index.ts',
    ),
    '^@members/competitions/browser$': path.join(
      __dirname,
      'libs/competitions/src/browser/index.ts',
    ),
    '^@members/competitions/(.*)$': path.join(
      __dirname,
      'libs/competitions/src/$1',
    ),
    '^@members/chores$': path.join(__dirname, 'libs/chores/src/index.ts'),
    '^@members/chores/(.*)$': path.join(__dirname, 'libs/chores/src/$1'),
    '^@members/results$': path.join(__dirname, 'libs/results/src/index.ts'),
    '^@members/results/(.*)$': path.join(__dirname, 'libs/results/src/$1'),
    '^@members/riders$': path.join(__dirname, 'libs/riders/src/index.ts'),
    '^@members/riders/(.*)$': path.join(__dirname, 'libs/riders/src/$1'),
    '^@members/slack$': path.join(__dirname, 'libs/slack/src/index.ts'),
    '^@members/slack/(.*)$': path.join(__dirname, 'libs/slack/src/$1'),
    '^@members/assistant$': path.join(__dirname, 'libs/assistant/src/index.ts'),
    '^@members/assistant/(.*)$': path.join(__dirname, 'libs/assistant/src/$1'),
    '^@members/test-utils$': path.join(
      __dirname,
      'libs/test-utils/src/index.ts',
    ),
    '^@members/test-utils/(.*)$': path.join(
      __dirname,
      'libs/test-utils/src/$1',
    ),
    '^@members/service-auth$': path.join(
      __dirname,
      'libs/service-auth/src/index.ts',
    ),
    '^@members/service-auth/(.*)$': path.join(
      __dirname,
      'libs/service-auth/src/$1',
    ),
    '^@members/logging$': path.join(__dirname, 'libs/logging/src/index.ts'),
    '^@members/logging/(.*)$': path.join(__dirname, 'libs/logging/src/$1'),
    '^@members/app$': path.join(__dirname, 'libs/app/src/index.ts'),
    '^@members/cloudevents$': path.join(
      __dirname,
      'libs/cloudevents/src/index.ts',
    ),
    '^@members/env$': path.join(__dirname, 'libs/env-vars/src/index.ts'),
    '^@members/firestore$': path.join(__dirname, 'libs/firestore/src/index.ts'),
    '^@members/firestore/(.*)$': path.join(__dirname, 'libs/firestore/src/$1'),
    '^@members/google$': path.join(__dirname, 'libs/google/src/index.ts'),
    '^@members/mail$': path.join(__dirname, 'libs/mail/src/index.ts'),
    '^@members/mail/(.*)$': path.join(__dirname, 'libs/mail/src/$1'),
    '^@members/races$': path.join(__dirname, 'libs/races/src/index.ts'),
    '^@members/races/(.*)$': path.join(__dirname, 'libs/races/src/$1'),
    '^@members/rag$': path.join(__dirname, 'libs/rag/src/index.ts'),
    '^@members/rag/(.*)$': path.join(__dirname, 'libs/rag/src/$1'),
    '^@members/secrets$': path.join(__dirname, 'libs/secrets/src/index.ts'),
    '^@members/squareup$': path.join(__dirname, 'libs/squareup/src/index.ts'),
    '^@members/squareup/(.*)$': path.join(__dirname, 'libs/squareup/src/$1'),
    '^@members/strava$': path.join(__dirname, 'libs/strava/src/index.ts'),
    '^@members/strava/(.*)$': path.join(__dirname, 'libs/strava/src/$1'),
    '^@members/util$': path.join(__dirname, 'libs/util/src/index.ts'),
    '^@members/util/(.*)$': path.join(__dirname, 'libs/util/src/$1'),
    '^@members/util-server$': path.join(
      __dirname,
      'libs/util-server/src/index.ts',
    ),
    '^@members/util-server/(.*)$': path.join(
      __dirname,
      'libs/util-server/src/$1',
    ),
    '^@members/jsx$': path.join(__dirname, 'libs/jsx/src/index.ts'),
    '^@members/jsx/(.*)$': path.join(__dirname, 'libs/jsx/src/$1'),
    '^@members/youtube$': path.join(__dirname, 'libs/youtube/src/index.ts'),
    '^@members/youtube/(.*)$': path.join(__dirname, 'libs/youtube/src/$1'),
    '^@members/ghost$': path.join(__dirname, 'libs/ghost/src/index.ts'),
    '^@members/provider-service$': path.join(
      __dirname,
      'libs/provider-service/src/index.ts',
    ),
    '^@members/provider-service/(.*)$': path.join(
      __dirname,
      'libs/provider-service/src/$1',
    ),
    '^@members/race-events$': path.join(
      __dirname,
      'libs/race-events/src/index.ts',
    ),
    '^@members/race-events/(.*)$': path.join(
      __dirname,
      'libs/race-events/src/$1',
    ),
    '^@members/export-sheets$': path.join(
      __dirname,
      'libs/export-sheets/src/index.ts',
    ),
    '^@members/export-sheets/(.*)$': path.join(
      __dirname,
      'libs/export-sheets/src/$1',
    ),
  },
};
