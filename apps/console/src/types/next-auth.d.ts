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
    /** Encrypted inside Auth.js's HTTP-only JWT cookie; never exposed by the
     * public session callback. */
    githubAccessToken?: string;
    /** Epoch ms of the sign-in or renewal that issued `githubAccessToken`. */
    githubAccessTokenIssuedAt?: number;
    /** Epoch ms at which GitHub stops honouring `githubAccessToken`. */
    githubAccessTokenExpiresAt?: number;
    /** Renews `githubAccessToken`; encrypted in the same cookie and never
     * attached to a session object. */
    githubRefreshToken?: string;
  }
}
