import {
  getAgentConsoleAdminGithubLogin,
  getAgentConsoleGithubOauthClientId,
  getAgentConsoleGithubOauthClientSecret,
  getAuthSecret,
} from '@repo/util-server';
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';

const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  secret: getAuthSecret(),
  session: { strategy: 'jwt' },
  providers: [
    GitHub({
      clientId: getAgentConsoleGithubOauthClientId(),
      clientSecret: getAgentConsoleGithubOauthClientSecret(),
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      const login = (profile as { login?: string } | undefined)?.login;
      return login === getAgentConsoleAdminGithubLogin();
    },
    jwt({ token, profile }) {
      const login = (profile as { login?: string } | undefined)?.login;
      if (login) token.githubLogin = login;
      return token;
    },
    session({ session, token }) {
      session.user.isAdmin =
        token.githubLogin === getAgentConsoleAdminGithubLogin();
      return session;
    },
  },
}));

export { auth, handlers, signIn, signOut };
