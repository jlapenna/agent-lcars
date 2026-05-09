import type { EnvVars } from '@members/env';

declare global {
  namespace NodeJS {
    type ProcessEnv = EnvVars;
  }
}

export {};
