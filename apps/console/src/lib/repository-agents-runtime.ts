import 'server-only';

import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';

import { controlPlaneRepositories } from './deployment';
import { createDispatchTokenProvider } from './github-app-tokens';
import { refreshAgentCatalogs } from './repository-agent-catalog';
import { FirestoreAgentStore } from './repository-agent-store';

let store: FirestoreAgentStore | undefined;
export function repositoryAgentStore(): FirestoreAgentStore {
  store ??= new FirestoreAgentStore(
    new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    }),
  );
  return store;
}

/** Catalog `.lcars/agents` across every control-plane repository on the
 * maintenance tick, as repository jobs are (docs/repository-agents.md). */
export async function maintainRepositoryAgents(
  deadline: number,
): Promise<void> {
  await refreshAgentCatalogs(
    repositoryAgentStore(),
    controlPlaneRepositories(),
    () => createDispatchTokenProvider(process.env, { contents: 'read' }),
    deadline,
  );
}
