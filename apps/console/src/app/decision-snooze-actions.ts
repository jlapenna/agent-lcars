'use server';

import { auth } from '@/auth';
import { createAdminAction } from '@/lib/auth-guards';
import {
  decisionSnoozeAnchorSchema,
  type DecisionSnoozeResult,
  importDecisionSnoozesSchema,
  snoozeDecisionSchema,
} from '@/lib/decision-snooze-contract';
import { getDecisionSnoozeStore } from '@/lib/decision-snooze-store';

const requireAdmin = createAdminAction(auth);

/** Server Actions enforce same-origin POSTs. The viewer is always derived
 * from the authenticated session, never accepted as a client-selected key. */
async function viewerId() {
  const session = await requireAdmin();
  if (!session.user.id) throw new Error('Unauthorized');
  return session.user.id;
}

export async function readDecisionSnoozes(): Promise<DecisionSnoozeResult> {
  const userId = await viewerId();
  try {
    return { ok: true, entries: await getDecisionSnoozeStore().read(userId) };
  } catch {
    return {
      ok: false,
      error: 'Unable to load your snoozes. Decisions remain visible.',
    };
  }
}

export async function snoozeDecision(
  input: unknown,
): Promise<DecisionSnoozeResult> {
  const userId = await viewerId();
  const parsed = snoozeDecisionSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'Invalid snooze duration or decision.' };
  try {
    return {
      ok: true,
      entries: await getDecisionSnoozeStore().change(
        userId,
        [parsed.data],
        parsed.data.minutes,
      ),
    };
  } catch {
    return {
      ok: false,
      error: 'Unable to save your snooze. Try again or unsnooze an older item.',
    };
  }
}

export async function unsnoozeDecision(
  input: unknown,
): Promise<DecisionSnoozeResult> {
  const userId = await viewerId();
  const parsed = decisionSnoozeAnchorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid decision.' };
  try {
    return {
      ok: true,
      entries: await getDecisionSnoozeStore().change(userId, [parsed.data]),
    };
  } catch {
    return { ok: false, error: 'Unable to remove your snooze. Try again.' };
  }
}

export async function importDecisionSnoozes(
  input: unknown,
): Promise<DecisionSnoozeResult> {
  const userId = await viewerId();
  const parsed = importDecisionSnoozesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid legacy snoozes.' };
  try {
    return {
      ok: true,
      entries: await getDecisionSnoozeStore().change(userId, parsed.data, 1440),
    };
  } catch {
    return {
      ok: false,
      error:
        'Unable to import your mutes. Browser preferences were not changed.',
    };
  }
}
