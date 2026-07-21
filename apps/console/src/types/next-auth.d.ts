import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    isAdmin?: boolean;
  }

  interface Session {
    user: DefaultSession['user'] & {
      isAdmin?: boolean;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    githubLogin?: string;
  }
}
