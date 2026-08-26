import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    isAdmin?: boolean;
    login?: string;
  }

  interface Session {
    user: DefaultSession['user'] & {
      isAdmin?: boolean;
      login?: string;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    githubLogin?: string;
  }
}
