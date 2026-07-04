import { redirect } from 'next/navigation';

import { auth, signIn } from '../../auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.isAdmin) {
    redirect('/');
  }

  return (
    <main
      style={{
        maxWidth: 360,
        margin: '20vh auto 0',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Agent Console</h1>
      <p style={{ color: '#9ca3af', marginBottom: 24 }}>
        supersprinklesracing/members &mdash; Claude issue agent activity
      </p>
      <form
        action={async () => {
          'use server';
          await signIn('github');
        }}
      >
        {/*
         * Explicit, theme-independent colors rather than relying on the
         * browser's `prefers-color-scheme` - NextAuth's built-in
         * /api/auth/signin page does that and its dark-mode button ends up
         * the same color as its dark-mode page background, making the
         * button unreadable.
         */}
        <button
          type="submit"
          style={{
            background: '#24292f',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '10px 20px',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sign in with GitHub
        </button>
      </form>
    </main>
  );
}
