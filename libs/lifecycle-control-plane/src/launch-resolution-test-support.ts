import { createHash } from 'node:crypto';

import type { AttemptState } from './attempt-reducer';
import { hydrateAttemptForTest } from './attempt-test-hydration';
import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  LaunchResponseBoundary,
  type VerifiedClaimedLaunchWork,
} from './launch-resolution-capability';

export async function resolveLaunchForTest(input: {
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  tenantId: string;
  attemptId: string;
  kind: 'accepted' | 'unknown';
  at: string;
  work?: VerifiedClaimedLaunchWork;
}): Promise<WriteResult> {
  const claim =
    input.work === undefined
      ? await input.storage.claimLaunchWork({
          lease: input.lease,
          tenantId: input.tenantId,
          attemptId: input.attemptId,
        })
      : undefined;
  const work = input.work ?? claim?.work;
  if (work === undefined) throw new Error('Launch work was not claimable');
  const response = new LaunchResponseBoundary(
    {
      resolve: async () => ({
        kind: input.kind,
        responseSha256: createHash('sha256')
          .update(`${input.attemptId}:${input.kind}`)
          .digest('hex'),
      }),
    },
    { now: () => input.at },
  );
  return input.storage.resolveVerifiedLaunch({
    lease: input.lease,
    resolution: await response.resolve(work),
  });
}

export function writeAttemptForTest(input: {
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  expectedRevision: number;
  next: AttemptState;
}): Promise<WriteResult> {
  return hydrateAttemptForTest(input.storage, input);
}
