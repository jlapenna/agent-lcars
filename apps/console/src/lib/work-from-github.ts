import 'server-only';

import {
  WORK_DESCRIPTION_MAX,
  WORK_TITLE_MAX,
  type WorkOrigin,
  type WorkPayload,
} from '@agent-lcars/work';

import type { Pipeline } from './orchestrator-ingest';

/** `workSpecSchema.description` is `min(1)`; a GitHub issue or PR may have
 *  a null or whitespace-only body. */
const EMPTY_DESCRIPTION = '(no description)';

/** Mirrors `prepare.sh`'s own clamp-and-marker shape for `anchor.body`, so
 *  a task derived here and a brief later built from an unrelated overlong
 *  body degrade the same visible way. */
export function truncatedDescription(body: string | null | undefined): string {
  const text = body?.trim();
  if (!text) return EMPTY_DESCRIPTION;
  if (text.length <= WORK_DESCRIPTION_MAX) return text;
  const marker =
    `\n\n[work: truncated to ${WORK_DESCRIPTION_MAX} of ${text.length} ` +
    `characters. Read the full body on the issue.]`;
  // Slice leaves room for the marker itself, so the total stays within
  // WORK_DESCRIPTION_MAX -- appending the marker after a full-length slice
  // would push the result over the bound `workPayloadSchema` enforces.
  return text.slice(0, WORK_DESCRIPTION_MAX - marker.length) + marker;
}

/** GitHub's own issue/PR title limit (256 characters) already equals
 *  `WORK_TITLE_MAX`; this clamp is defensive, not expected to ever
 *  actually shorten a real title. */
function clampedTitle(title: string): string {
  return title.length <= WORK_TITLE_MAX
    ? title
    : title.slice(0, WORK_TITLE_MAX);
}

/**
 * The `work.origin.principal` for a GitHub-derived task: `github:<login>`
 * when the webhook (or the console session) named an actor, else
 * `github:label:<label>` for a label webhook whose delivery carried no
 * `sender`, else `github:unknown`. See the design spec's "`work` for
 * every anchor" derivation table.
 */
export function githubOrigin(
  actor: string | undefined,
  label?: string,
): WorkOrigin {
  const suffix = actor ?? (label !== undefined ? `label:${label}` : 'unknown');
  return { principal: `github:${suffix}`, channel: 'github' };
}

export interface GithubWorkSource {
  title: string;
  body: string | null | undefined;
  pipeline: Pipeline;
  repo: string;
  /** The webhook `sender.login`, or the console session's github login for
   *  a retrigger. */
  actor: string | undefined;
  /** Label-webhook fallback only, used by `githubOrigin` when `actor` is
   *  absent -- irrelevant for a retrigger, which always has a session
   *  actor. */
  label?: string;
}

/**
 * Builds the `WorkPayload` a GitHub-anchored `requestRun` call attaches to
 * a task on its first request (`decide.ts`'s `baseTask` carries it forward
 * on every later request -- see the design spec's "write once" note).
 */
export function workPayloadFromGithub(source: GithubWorkSource): WorkPayload {
  return {
    origin: githubOrigin(source.actor, source.label),
    spec: {
      title: clampedTitle(source.title),
      description: truncatedDescription(source.body),
      pipeline: source.pipeline,
      target: { repo: source.repo },
    },
  };
}
