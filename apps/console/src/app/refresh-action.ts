'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { createAdminAction } from '@/lib/auth-guards';

import { auth } from '../auth';
import { AUTHORITATIVE_QUEUE_TAG } from '../lib/cache-tags';

// Deliberately its own module rather than another export of `actions.ts`:
// `refresh-button.tsx` is a client component rendered in the footer of every
// page, and importing it from `actions.ts` would pull that whole file's
// transitive server surface (backend-actions -> Octokit, Firestore) into
// every tree that renders the button.
const requireAdmin = createAdminAction(auth);

/**
 * Backs the header's Refresh control. Refresh re-reads the control plane's
 * Work/Task/Run and webhook-anchor projections; it never fans out to GitHub.
 *
 * Admin-gated like every other action here, and not merely for consistency:
 * an ungated cache-buster is still a lever for forcing repeated datastore
 * reads.
 */
export async function refreshDashboard(): Promise<void> {
  await requireAdmin();
  updateTag(AUTHORITATIVE_QUEUE_TAG);
  revalidatePath('/');
}
