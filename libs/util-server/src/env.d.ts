import type { EnvVars } from '@agent-lcars/env';

declare global {
  namespace NodeJS {
    type ProcessEnv = EnvVars;
  }
}

export {};
