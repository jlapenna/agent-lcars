import 'server-only';

import {
  AUTHORITATIVE_TASK_STATE_SCHEMA,
  type AuthoritativeTaskState,
  redactAuthoritativeTaskState,
} from '@agent-lcars/dispatch-contracts';
import { FirestoreStoragePort } from '@agent-lcars/dispatch-controller/storage/firestore-port';
import { required } from '@agent-lcars/util-server';

import { getGithubClient, repoItemKey, repoKey } from './github-client';
import type { TaskRef, WatchedRepo } from './watched-repo';

export interface AuthoritativeTaskStateSet {
  states: Map<string, AuthoritativeTaskState>;
  unavailableTaskKeys: Set<string>;
  warnings: string[];
}

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

/**
 * The console's single server-side lifecycle adapter. Repository ids are
 * resolved once per repository, then every task aggregate is read directly
 * from the controller authority. A failed read is recorded explicitly; it
 * is never replaced with the compatibility comment parsed from GitHub.
 */
export async function readAuthoritativeTaskStates(
  tasks: TaskRef[],
): Promise<AuthoritativeTaskStateSet> {
  const uniqueTasks = new Map(tasks.map((task) => [taskRefKey(task), task]));
  const repos = new Map<string, WatchedRepo>();
  for (const task of uniqueTasks.values()) {
    repos.set(repoKey(task.repository), task.repository);
  }

  const repositoryIds = new Map<string, number>();
  const unavailableTaskKeys = new Set<string>();
  const warnings: string[] = [];
  await Promise.all(
    [...repos].map(async ([key, repo]) => {
      try {
        const { data } = await getGithubClient().rest.repos.get({
          owner: repo.owner,
          repo: repo.name,
        });
        repositoryIds.set(key, data.id);
      } catch (error) {
        console.error(
          'agent-lcars: failed to resolve repository id (%s):',
          key,
          error,
        );
        warnings.push(`Authoritative lifecycle state unavailable for ${key}.`);
        for (const [taskKey, task] of uniqueTasks) {
          if (repoKey(task.repository) === key)
            unavailableTaskKeys.add(taskKey);
        }
      }
    }),
  );

  const states = new Map<string, AuthoritativeTaskState>();
  await Promise.all(
    [...uniqueTasks].map(async ([key, task]) => {
      const repository = repoKey(task.repository);
      const repositoryId = repositoryIds.get(repository);
      if (repositoryId === undefined) return;
      try {
        const state = await readAuthoritativeTaskState({
          repositoryId,
          repository,
          issue: task.issueNumber,
        });
        if (state) states.set(key, state);
      } catch (error) {
        console.error(
          'agent-lcars: failed to read authoritative task state (%s):',
          key,
          error,
        );
        unavailableTaskKeys.add(key);
        warnings.push(`Authoritative lifecycle state unavailable for ${key}.`);
      }
    }),
  );

  return { states, unavailableTaskKeys, warnings };
}

function taskRefKey(task: TaskRef): string {
  return repoItemKey(task.repository, task.issueNumber);
}
