/* eslint-disable no-restricted-syntax */
const nxPreset = require('@nx/jest/preset').default;
const path = require('path');

module.exports = {
  ...nxPreset,
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!.*(?:uuid|cls-rtracer|md-to-slack|marked|p-limit|yocto-queue|p-wait-for|p-timeout|superjson|copy-anything|is-what|commander|next-auth|@auth/core|jose))',
  ],
  moduleNameMapper: {
    'server-only': path.join(
      __dirname,
      'libs/test-utils/src/server-only-mock.js',
    ),
    '^uuid$': require.resolve('uuid'),
    '^@repo/auth/(.*)$': path.join(__dirname, 'libs/auth/src/$1'),
    '^@repo/firebase-server$': path.join(
      __dirname,
      'libs/firebase-server/src/index.ts',
    ),
    '^@repo/firebase-server/(.*)$': path.join(
      __dirname,
      'libs/firebase-server/src/$1',
    ),
    '^@repo/instagram$': path.join(__dirname, 'libs/instagram/src/index.ts'),
    '^@repo/instagram/(.*)$': path.join(__dirname, 'libs/instagram/src/$1'),
    '^@repo/invites$': path.join(__dirname, 'libs/invites/src/index.ts'),
    '^@repo/invites/(.*)$': path.join(__dirname, 'libs/invites/src/$1'),
    '^@repo/onboarding$': path.join(__dirname, 'libs/onboarding/src/index.ts'),
    '^@repo/onboarding/(.*)$': path.join(__dirname, 'libs/onboarding/src/$1'),
    '^@repo/qbp$': path.join(__dirname, 'libs/qbp/src/index.ts'),
    '^@repo/qbp/(.*)$': path.join(__dirname, 'libs/qbp/src/$1'),
    '^@repo/competitions$': path.join(
      __dirname,
      'libs/competitions/src/index.ts',
    ),
    '^@repo/competitions/ui$': path.join(
      __dirname,
      'libs/competitions/src/ui/index.ts',
    ),
    '^@repo/competitions/(.*)$': path.join(
      __dirname,
      'libs/competitions/src/$1',
    ),
    '^@repo/chores$': path.join(__dirname, 'libs/chores/src/index.ts'),
    '^@repo/chores/(.*)$': path.join(__dirname, 'libs/chores/src/$1'),
    '^@repo/results$': path.join(__dirname, 'libs/results/src/index.ts'),
    '^@repo/results/(.*)$': path.join(__dirname, 'libs/results/src/$1'),
    '^@repo/riders$': path.join(__dirname, 'libs/riders/src/index.ts'),
    '^@repo/riders/(.*)$': path.join(__dirname, 'libs/riders/src/$1'),
    '^@repo/slack$': path.join(__dirname, 'libs/slack/src/index.ts'),
    '^@repo/slack/(.*)$': path.join(__dirname, 'libs/slack/src/$1'),
    '^@repo/assistant$': path.join(__dirname, 'libs/assistant/src/index.ts'),
    '^@repo/assistant/(.*)$': path.join(__dirname, 'libs/assistant/src/$1'),
    '^@repo/test-utils$': path.join(__dirname, 'libs/test-utils/src/index.ts'),
    '^@repo/test-utils/(.*)$': path.join(__dirname, 'libs/test-utils/src/$1'),
    '^@repo/service-auth$': path.join(
      __dirname,
      'libs/service-auth/src/index.ts',
    ),
    '^@repo/service-auth/(.*)$': path.join(
      __dirname,
      'libs/service-auth/src/$1',
    ),
    '^@repo/logging$': path.join(__dirname, 'libs/logging/src/index.ts'),
    '^@repo/logging/(.*)$': path.join(__dirname, 'libs/logging/src/$1'),
    '^@repo/app$': path.join(__dirname, 'libs/app/src/index.ts'),
    '^@repo/cloudevents$': path.join(
      __dirname,
      'libs/cloudevents/src/index.ts',
    ),
    '^@repo/env$': path.join(__dirname, 'libs/env-vars/src/index.ts'),
    '^@repo/firestore$': path.join(__dirname, 'libs/firestore/src/index.ts'),
    '^@repo/firestore/(.*)$': path.join(__dirname, 'libs/firestore/src/$1'),
    '^@repo/google$': path.join(__dirname, 'libs/google/src/index.ts'),

    '^@repo/races$': path.join(__dirname, 'libs/races/src/index.ts'),
    '^@repo/races/(.*)$': path.join(__dirname, 'libs/races/src/$1'),
    '^@repo/rag$': path.join(__dirname, 'libs/rag/src/index.ts'),
    '^@repo/rag/(.*)$': path.join(__dirname, 'libs/rag/src/$1'),
    '^@repo/secrets$': path.join(__dirname, 'libs/secrets/src/index.ts'),
    '^@repo/squareup$': path.join(__dirname, 'libs/squareup/src/index.ts'),
    '^@repo/squareup/(.*)$': path.join(__dirname, 'libs/squareup/src/$1'),
    '^@repo/strava$': path.join(__dirname, 'libs/strava/src/index.ts'),
    '^@repo/strava/(.*)$': path.join(__dirname, 'libs/strava/src/$1'),
    '^@repo/util$': path.join(__dirname, 'libs/util/src/index.ts'),
    '^@repo/util/(.*)$': path.join(__dirname, 'libs/util/src/$1'),
    '^@repo/util-server$': path.join(
      __dirname,
      'libs/util-server/src/index.ts',
    ),
    '^@repo/util-server/(.*)$': path.join(__dirname, 'libs/util-server/src/$1'),
    '^@repo/jsx$': path.join(__dirname, 'libs/jsx/src/index.ts'),
    '^@repo/jsx/(.*)$': path.join(__dirname, 'libs/jsx/src/$1'),
    '^@repo/youtube$': path.join(__dirname, 'libs/youtube/src/index.ts'),
    '^@repo/youtube/(.*)$': path.join(__dirname, 'libs/youtube/src/$1'),
    '^@repo/ghost$': path.join(__dirname, 'libs/ghost/src/index.ts'),
    '^@repo/provider-service$': path.join(
      __dirname,
      'libs/provider-service/src/index.ts',
    ),
    '^@repo/provider-service/(.*)$': path.join(
      __dirname,
      'libs/provider-service/src/$1',
    ),
    '^@repo/race-events$': path.join(
      __dirname,
      'libs/race-events/src/index.ts',
    ),
    '^@repo/race-events/(.*)$': path.join(__dirname, 'libs/race-events/src/$1'),
    '^@repo/export-sheets$': path.join(
      __dirname,
      'libs/export-sheets/src/index.ts',
    ),
    '^@repo/export-sheets/(.*)$': path.join(
      __dirname,
      'libs/export-sheets/src/$1',
    ),
    '^@repo/stripe$': path.join(__dirname, 'libs/stripe/src/index.ts'),
    '^@repo/app-providers$': path.join(
      __dirname,
      'libs/app-providers/src/index.ts',
    ),
  },
  maxWorkers: process.env.JEST_MAX_WORKERS
    ? isNaN(process.env.JEST_MAX_WORKERS)
      ? process.env.JEST_MAX_WORKERS
      : parseInt(process.env.JEST_MAX_WORKERS, 10)
    : 1,
  workerIdleMemoryLimit: '512MB',
};
