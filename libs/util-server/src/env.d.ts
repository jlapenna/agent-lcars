import type { EnvVars } from '@repo/env';

declare global {
  namespace NodeJS {
    type ProcessEnv = EnvVars;
  }
}

export {};
