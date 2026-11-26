import { z } from 'zod';

/** Issue identity is independent of the repository in which an agent works. */
export const githubIssueReferenceSchema = z.strictObject({
  tracker: z.literal('github'),
  repo: z
    .string()
    .max(140)
    .regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive(),
});
export const linearIssueReferenceSchema = z.strictObject({
  tracker: z.literal('linear'),
  organizationId: z.uuid(),
  issueId: z.uuid(),
});
export const issueReferenceSchema = z.discriminatedUnion('tracker', [
  githubIssueReferenceSchema,
  linearIssueReferenceSchema,
]);
export type IssueReference = z.infer<typeof issueReferenceSchema>;

export function issueSourceKey(issue: IssueReference): string {
  return issue.tracker === 'github'
    ? `github:${issue.repo}#${issue.issue}`
    : `linear:${issue.organizationId}:${issue.issueId}`;
}

/** GitHub's issue title and body limits. Linear documents none; a Linear issue
 * beyond these is still tracked for identity and lifecycle (see `oversized`),
 * but no new brief is built from it. */
export const TRACKER_ISSUE_TITLE_MAX = 256;
export const TRACKER_ISSUE_DESCRIPTION_MAX = 65_536;

/** Current tracker facts on Task and immutable snapshots captured at run admission. */
export const trackerIssueSchema = z.strictObject({
  reference: issueReferenceSchema,
  identifier: z.string().min(1).max(256),
  url: z.url().max(2048),
  title: z.string().min(1).max(TRACKER_ISSUE_TITLE_MAX),
  description: z.string().max(TRACKER_ISSUE_DESCRIPTION_MAX),
  /** The source title or description exceeds the bounds above. The snapshot
   * then carries no description and a bounded title, kept only for identity,
   * lifecycle and outcome publication; admission and briefs refuse it. */
  oversized: z.literal(true).optional(),
  state: z.enum(['open', 'closed']),
  updatedAt: z.iso.datetime(),
  teamId: z.uuid().optional(),
  status: z
    .strictObject({
      id: z.string().min(1).max(256),
      name: z.string().max(256),
      type: z.string().max(128),
    })
    .optional(),
  labels: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        name: z.string().max(256),
      }),
    )
    .max(256),
  assignees: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        name: z.string().max(256),
      }),
    )
    .max(256),
});
export type TrackerIssue = z.infer<typeof trackerIssueSchema>;

export const trackerIssueDisplaySchema = trackerIssueSchema.pick({
  reference: true,
  identifier: true,
  url: true,
  title: true,
  state: true,
  oversized: true,
});
export type TrackerIssueDisplay = z.infer<typeof trackerIssueDisplaySchema>;

export function trackerIssueDisplay(
  issue: TrackerIssueDisplay,
): TrackerIssueDisplay {
  const { reference, identifier, url, title, state, oversized } = issue;
  return {
    reference,
    identifier,
    url,
    title,
    state,
    ...(oversized === undefined ? {} : { oversized }),
  };
}

export const trackerIssueProjectionSchema = z.strictObject({
  issue: trackerIssueSchema,
  repo: z
    .string()
    .max(140)
    .regex(/^[\w.-]+\/[\w.-]+$/u)
    .optional(),
  observedAt: z.iso.datetime(),
});
export type TrackerIssueProjection = z.infer<
  typeof trackerIssueProjectionSchema
>;

export const issueCommentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  body: z.string().max(65_536),
  url: z.url().max(2048),
  author: z.string().max(256).optional(),
  updatedAt: z.iso.datetime(),
});
export type IssueComment = z.infer<typeof issueCommentSchema>;
