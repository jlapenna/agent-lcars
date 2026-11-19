import {
  type AgentHarness,
  agentHarnessSchema,
  agentModeSchema,
} from '@agent-lcars/work';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { jobDigest } from './repository-job-definition';

/** A repository-owned claw agent (`.lcars/agents/<name>/`,
 * docs/repository-agents.md). Only `description` is required. Concurrency
 * and resources belong to the executor runtime the profile names. */
const agentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);

export const SOURCE_FAILED = 'Source refresh failed';
export const REMOVED = 'Definition removed';

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
  /** The harness that runs the agent's turn: embedded OpenClaw (the
   * default) or an ACP harness the claw runner image carries. */
  harness: agentHarnessSchema.optional(),
  /** The harness's ACP session mode the turn runs in. What it controls is
   * the harness's own: the permission policy the harness itself enforces
   * for Codex (`read-only`) and Claude Code (`plan`), a thinking level for
   * OpenClaw, whose tool permissions come from its config and exec
   * approvals. Omitted means the mode the launcher runs that harness in: the
   * harness's own default for OpenClaw and Claude Code, `workspace-write`
   * for Codex. */
  mode: agentModeSchema.optional(),
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
  /** How many files the digest covers. The file list itself is not stored:
   * a definition can hold any number of files, and a run re-reads them at
   * its pinned revision and checks this digest. */
  fileCount: z.number().int().positive(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** Files the launcher needs for each harness. A definition without them is
 * invalid. Only OpenClaw reads a config and exec approvals; an ACP harness is
 * configured by its own files in the agent's `workspace/` and `home/`. */
export function requiredAgentFiles(
  harness: AgentHarness = 'openclaw',
): readonly string[] {
  return harness === 'openclaw'
    ? ['agent.yaml', 'config.json', 'approvals.json']
    : ['agent.yaml'];
}

/** The agent ID: `<owner>/<repo>/<name>`. */
export function agentId(repository: string, name: string): string {
  return `${repositorySchema.parse(repository)}/${agentNameSchema.parse(name)}`;
}

/** Stable storage key for an agent ID. */
/** Stable storage key for an agent directory. It never validates, so a
 * malformed name is still recorded (with its error) instead of failing the
 * repository's whole refresh. */
export function agentKey(repository: string, name: string): string {
  return jobDigest(['agent', `${repository}/${name}`]);
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
  agentId(repository, name);
  for (const entry of files)
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
      throw new Error(
        `Agent files must be regular files: ${entry.path} (${entry.mode})`,
      );
  const pinned = files.map(({ path, mode, sha }) =>
    agentFileSchema.parse({ path, mode, sha }),
  );
  const manifest = parseAgentManifest(manifestText);
  for (const required of requiredAgentFiles(manifest.harness))
    if (!pinned.some((file) => file.path === required))
      throw new Error(`Agent is missing ${required}`);
  return agentDefinitionSchema.parse({
    repository,
    name,
    revision,
    digest: agentDigest(pinned),
    manifest,
    fileCount: pinned.length,
  });
}
