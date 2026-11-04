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

/** Current tracker facts on Task; copied onto Run at admission so an issue
 * edit cannot change the brief of an executing or retried conversation. */
export const trackerIssueSchema = z.strictObject({
  reference: issueReferenceSchema,
  identifier: z.string().min(1).max(256),
  url: z.url().max(2048),
  title: z.string().min(1).max(256),
  description: z.string().max(65_536),
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
