import { pipelineContract } from '@agent-lcars/dispatch-contracts';

import {
  type AgentPipeline,
  repoKey,
  type RepositoryRef,
} from './watched-repo';

/** The minimal item identity the local-agent prompt needs - narrower than
 * `ActionItem` so this module (and its tests) don't depend on the full
 * queue-item shape. */
export interface LocalAgentPromptItem {
  repo: RepositoryRef;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
}

/** Single-quotes `value` for a POSIX shell command line, closing and
 * reopening the quote around any embedded single quote (`it's` ->
 * `'it'\''s'`) - the standard technique, since a single-quoted string has no
 * escape character of its own. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The agent-agnostic prompt text - what changes per pipeline in
 * `localAgentCommand` below is only the CLI invocation wrapping this. */
export function localAgentPromptText(item: LocalAgentPromptItem): string {
  const kind = item.kind === 'pr' ? 'PR' : 'issue';
  return `Take on ${repoKey(item.repo)}#${item.number} (${kind}): ${item.title}\n${item.url}`;
}

/** Each pipeline's plain interactive CLI invocation - no headless/resume
 * flags, matching how a maintainer already runs these tools on their own
 * workstation (see docs/superpowers/specs/2026-09-03-resumable-agent-
 * conversations-design.md's CLI table for the flagged headless variants this
 * deliberately omits). */
const LOCAL_AGENT_INVOCATIONS: Record<
  AgentPipeline,
  (quotedPrompt: string) => string
> = {
  claude: (prompt) => `claude ${prompt}`,
  codex: (prompt) => `codex ${prompt}`,
  opencode: (prompt) => `opencode run ${prompt}`,
};

/** The full command line a maintainer pastes into a local `pipeline` CLI
 * session to hand it this item, quoted for a POSIX shell. */
export function localAgentCommand(
  pipeline: AgentPipeline,
  item: LocalAgentPromptItem,
): string {
  return LOCAL_AGENT_INVOCATIONS[pipeline](
    shellQuote(localAgentPromptText(item)),
  );
}

/** Human-facing name for the agent picker - "Claude"/"Codex"/"OpenCode",
 * not the `agent:*` label or reply-trigger spellings other pickers use. */
export function localAgentDisplayName(pipeline: AgentPipeline): string {
  return pipelineContract(pipeline).displayName;
}
