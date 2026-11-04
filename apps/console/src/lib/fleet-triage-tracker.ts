import 'server-only';

import { createHash } from 'node:crypto';

import type { TriageAnchor } from '@agent-lcars/dispatch-contracts';
import { issueSourceKey } from '@agent-lcars/dispatch-contracts';
import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { getGithubClient } from './github-client';
import { issueTracker } from './issue-trackers';
import {
  linearQuery,
  readLinearComment,
  readLinearIssue,
  readLinearLabels,
  updateLinearIssue,
} from './linear-client';
import { linearConfig, linearTeam } from './linear-config';

export async function hasCodingHistory(
  store: OrchestratorStore,
  anchor: TriageAnchor,
): Promise<boolean> {
  if (!('source' in anchor)) return (await store.listRuns(anchor)).length > 0;
  const workId = await store.readSourceWorkId(issueSourceKey(anchor.source));
  return workId !== undefined && (await store.listRuns({ workId })).length > 0;
}

export async function triageTracker(anchor: TriageAnchor) {
  const [owner = '', repo = ''] = anchor.repo.split('/');
  const github = getGithubClient();
  if (!('source' in anchor))
    return {
      labels: async () => {
        const result: { id: string; name: string }[] = [];
        for (let page = 1; page <= 5; page++) {
          const labels = await github.issues.listLabelsForRepo({
            owner,
            repo,
            per_page: 100,
            page,
          });
          result.push(
            ...labels.data.map((label) => ({
              id: label.name,
              name: label.name,
            })),
          );
          if (labels.data.length < 100) return result;
        }
        throw new Error('Repository label read exceeds bound');
      },
      addLabels: async (labels: string[]) => {
        await github.issues.addLabels({
          owner,
          repo,
          issue_number: anchor.issue,
          labels,
        });
      },
      writeComment: async (
        body: string,
        id?: string | number,
      ): Promise<string | number> => {
        if (id !== undefined && typeof id !== 'number')
          throw new Error('Invalid GitHub triage comment identity');
        const result =
          id === undefined
            ? await github.issues.createComment({
                owner,
                repo,
                issue_number: anchor.issue,
                body,
              })
            : await github.issues.updateComment({
                owner,
                repo,
                comment_id: id,
                body,
              });
        return result.data.id;
      },
      readComment: async (id: string | number) => {
        if (typeof id !== 'number')
          throw new Error('Invalid GitHub triage comment identity');
        return (await github.issues.getComment({ owner, repo, comment_id: id }))
          .data.body;
      },
      dispatchLabel: 'agent:opencode',
      dispatchObserved: async (since: string) => {
        const data = await github.graphql<{
          repository: {
            issue: {
              timelineItems: {
                nodes: { createdAt: string; label?: { name: string } }[];
                pageInfo: { hasPreviousPage: boolean };
              };
            };
          };
        }>(
          `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { issue(number:$number) { timelineItems(itemTypes:[LABELED_EVENT],last:100) { nodes { ... on LabeledEvent { createdAt label { name } } } pageInfo { hasPreviousPage } } } } }`,
          { owner, name: repo, number: anchor.issue },
        );
        const timeline = data.repository.issue.timelineItems;
        if (
          timeline.nodes.some(
            (event) =>
              Date.parse(event.createdAt) >=
                Math.floor(Date.parse(since) / 1000) * 1000 &&
              event.label?.name === 'agent:opencode',
          )
        )
          return true;
        if (
          timeline.pageInfo.hasPreviousPage &&
          (!timeline.nodes[0] || timeline.nodes[0].createdAt >= since)
        )
          throw new Error('Triage dispatch read-back is incomplete');
        return false;
      },
    };
  const reference = anchor.source;
  const config = linearConfig();
  const issue = await readLinearIssue(
    reference.organizationId,
    reference.issueId,
  );
  const team = issue && config && linearTeam(config, issue.teamId ?? '');
  const triage = team && 'triage' in team ? team.triage : undefined;
  if (
    !config ||
    config.organizationId !== reference.organizationId ||
    !issue ||
    !triage
  )
    throw new Error('Linear triage binding unavailable');
  return {
    labels: () => readLinearLabels(issue.teamId as string),
    addLabels: (labels: string[]) =>
      updateLinearIssue(reference.organizationId, reference.issueId, {
        addedLabelIds: labels,
      }),
    writeComment: async (
      body: string,
      existing?: string | number,
    ): Promise<string | number> => {
      if (existing !== undefined) {
        if (typeof existing !== 'string')
          throw new Error('Invalid Linear triage comment identity');
        const current = await readLinearComment(existing);
        if (current?.issue?.id !== reference.issueId)
          throw new Error('Linear triage comment belongs to another issue');
        const result = z
          .object({ commentUpdate: z.object({ success: z.boolean() }) })
          .parse(
            await linearQuery(
              `mutation LcarsTriageCommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`,
              { id: existing, input: { body } },
            ),
          );
        if (!result.commentUpdate.success)
          throw new Error('Linear triage comment update failed');
        return existing;
      }
      const hex = createHash('sha256')
        .update(JSON.stringify(['lcars-triage', reference, body]))
        .digest('hex');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      await issueTracker().comment(reference, id, body);
      return id;
    },
    readComment: async (id: string | number) => {
      if (typeof id !== 'string')
        throw new Error('Invalid Linear triage comment identity');
      const comment = await readLinearComment(id);
      if (comment?.issue?.id !== reference.issueId)
        throw new Error('Linear triage comment belongs to another issue');
      return comment.body;
    },
    dispatchLabel: triage.readyLabelId,
    dispatchObserved: async (since: string) => {
      let after: string | null = null;
      for (let page = 0; page < 5; page++) {
        const data = z
          .object({
            issue: z.object({
              history: z.object({
                nodes: z.array(
                  z.object({
                    createdAt: z.string(),
                    addedLabelIds: z.array(z.string()).nullable(),
                  }),
                ),
                pageInfo: z.object({
                  hasNextPage: z.boolean(),
                  endCursor: z.string().nullable(),
                }),
              }),
            }),
          })
          .parse(
            await linearQuery(
              `query LcarsTriageHistory($id: String!, $after: String) { issue(id: $id) { history(first: 100, after: $after) { nodes { createdAt addedLabelIds } pageInfo { hasNextPage endCursor } } } }`,
              { id: reference.issueId, after },
            ),
          );
        if (
          data.issue.history.nodes.some(
            (event) =>
              Date.parse(event.createdAt) >=
                Math.floor(Date.parse(since) / 1000) * 1000 &&
              event.addedLabelIds?.includes(triage.readyLabelId),
          )
        )
          return true;
        if (!data.issue.history.pageInfo.hasNextPage) return false;
        after = data.issue.history.pageInfo.endCursor;
        if (!after) throw new Error('Linear history pagination is incomplete');
      }
      throw new Error('Linear triage history exceeds the bounded read');
    },
  };
}
