'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { createAdminAction } from '@/lib/auth-guards';

import { auth } from '../auth';
import { GITHUB_DATA_TAG } from '../lib/cache-tags';

// Deliberately its own module rather than another export of `actions.ts`:
// `refresh-button.tsx` is a client component rendered in the footer of every
// page, and importing it from `actions.ts` would pull that whole file's
// transitive server surface (backend-actions -> Octokit, Firestore) into
// every tree that renders the button.
const requireAdmin = createAdminAction(auth);

/**
 * Backs the header's Refresh control. Refresh has to mean "go ask GitHub
 * again" - a plain `router.refresh()` would re-render straight off the
 * cached read and look like a no-op, which is worse than not having the
 * button.
 *
 * Admin-gated like every other action here, and not merely for consistency:
 * an ungated cache-buster is a lever for forcing unbounded GitHub refetches,
 * which is the exact budget this cache exists to protect.
 */
export async function refreshDashboard(): Promise<void> {
  await requireAdmin();
  updateTag(GITHUB_DATA_TAG);
  revalidatePath('/');
}
