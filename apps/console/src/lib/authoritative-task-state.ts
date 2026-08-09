import 'server-only';

import {
  AUTHORITATIVE_TASK_STATE_SCHEMA,
  type AuthoritativeTaskState,
  redactAuthoritativeTaskState,
} from '@agent-lcars/dispatch-contracts';
import { FirestoreStoragePort } from '@agent-lcars/dispatch-controller/storage/firestore-port';
import { required } from '@agent-lcars/util-server';

export async function readAuthoritativeTaskState({
  repositoryId,
  repository,
  issue,
}: {
  repositoryId: number;
  repository: string;
  issue: number;
}): Promise<AuthoritativeTaskState | undefined> {
  const stored = await new FirestoreStoragePort({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  }).readTask({ repositoryId, repository, issue });
  if (!stored?.controllerState) return undefined;
  return redactAuthoritativeTaskState({
    schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
    task: stored.task,
    storageRevision: stored.revision,
    updatedAt: stored.updatedAt,
    controllerState: stored.controllerState,
  });
}
