import { parseDocument } from 'yaml';
import { z } from 'zod';

import { jobDigest } from './repository-job-definition';

/** A repository-owned claw agent (`.lcars/agents/<name>/`,
 * docs/repository-agents.md). Only `description` is required; everything
 * else falls back to the executor runtime's defaults. */
const agentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);

export const agentManifestSchema = z.strictObject({
  description: z.string().min(1),
  /** The operator-owned profile granting this agent's credentials; omitted
   * means the default profile (model key only). */
  profile: agentNameSchema.optional(),
  /** `terminal` for agents with effect authority: lost and failed attempts
   * are not rerun automatically. */
  retry: z.enum(['finite', 'terminal']).optional(),
  /** A report produced without any tool call is a failed attempt. */
  requireToolEvidence: z.boolean().optional(),
  maxLiveClaims: z.number().int().positive().optional(),
  allocation: z
    .strictObject({
      cpu: z.union([z.string(), z.number()]).optional(),
      memory: z.string().optional(),
    })
    .optional(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

const agentFileSchema = z.strictObject({
  /** Path relative to the agent directory. */
  path: z.string().min(1),
  /** Git file mode (100644 or 100755). */
  mode: z.enum(['100644', '100755']),
  /** Git blob SHA: content-addressed, so it pins the file's bytes. */
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
});
export type AgentFile = z.infer<typeof agentFileSchema>;

export const agentDefinitionSchema = z.strictObject({
  repository: repositorySchema,
  name: agentNameSchema,
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  /** sha256 over every file's path, mode and blob SHA. */
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifest: agentManifestSchema,
  files: z.array(agentFileSchema).min(1),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** Files the launcher needs. A definition without them is invalid. */
export const REQUIRED_AGENT_FILES = Object.freeze([
  'agent.yaml',
  'config.json',
  'approvals.json',
]);

/** The agent ID: `<owner>/<repo>/<name>`. */
export function agentId(repository: string, name: string): string {
  return `${repositorySchema.parse(repository)}/${agentNameSchema.parse(name)}`;
}

/** Stable storage key for an agent ID. */
export function agentKey(repository: string, name: string): string {
  return jobDigest(['agent', agentId(repository, name)]);
}

export function agentDigest(files: readonly AgentFile[]): string {
  return jobDigest(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, mode, sha }) => [path, mode, sha]),
  );
}

/** Strict YAML: aliases and duplicate keys fail, as do unknown manifest
 * fields, so a misspelled field cannot be silently ignored. */
export function parseAgentManifest(text: string): AgentManifest {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML');
  return agentManifestSchema.parse(document.toJS({ maxAliasCount: 0 }));
}

export function parseAgentDefinition(
  repository: string,
  revision: string,
  name: string,
  files: readonly { path: string; mode: string; type: string; sha: string }[],
  manifestText: string,
): AgentDefinition {
  for (const entry of files)
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
      throw new Error(
        `Agent files must be regular files: ${entry.path} (${entry.mode})`,
      );
  const pinned = files.map(({ path, mode, sha }) =>
    agentFileSchema.parse({ path, mode, sha }),
  );
  for (const required of REQUIRED_AGENT_FILES)
    if (!pinned.some((file) => file.path === required))
      throw new Error(`Agent is missing ${required}`);
  return agentDefinitionSchema.parse({
    repository,
    name,
    revision,
    digest: agentDigest(pinned),
    manifest: parseAgentManifest(manifestText),
    files: [...pinned].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
}
