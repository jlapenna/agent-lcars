import 'server-only';

import {
  isWorkAnchor,
  type OrchestratorStore,
  type Run,
  withFullRunMessages,
} from '@agent-lcars/orchestrator';

import { humanDecisionFromHandoff } from './human-ask';

export async function readGithubHumanDecision(
  store: Pick<OrchestratorStore, 'readRunMessage'>,
  run: Run,
) {
  if (
    isWorkAnchor(run.task) ||
    run.state !== 'finished' ||
    !run.result?.ok ||
    run.result.summary !== 'park'
  )
    return undefined;
  const { repo, issue } = run.task;
  const candidates = [run.result.ref, ...(run.result.relatedRefs ?? [])];
  const hasParkArtifact = candidates.some((ref) =>
    ['issues', 'pull'].some((kind) => {
      const prefix = `https://github.com/${repo}/${kind}/${issue}#issuecomment-`;
      return ref?.startsWith(prefix) && /^\d+$/.test(ref.slice(prefix.length));
    }),
  );
  if (!hasParkArtifact) return undefined;
  const [full] = await withFullRunMessages(store, [run]);
  if (full?.result?.messageOverflow) return undefined;
  const decision = humanDecisionFromHandoff(full?.result?.message);
  return decision ? { ...decision, runId: run.runId } : undefined;
}
