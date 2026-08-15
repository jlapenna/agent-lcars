import {
  parseSessionTitleAnnotationV1,
  SessionTitleAnnotationV1,
} from './session-title-annotation';
import { SessionSummary, SessionTitleSource } from './types';
import { asRecord, truncateTitle } from './unknown-value';

export interface SessionTitleSelectionInput {
  explicit?: unknown;
  annotation?: unknown;
  inferred?: unknown;
}

export interface SessionTitleSelection {
  title: string;
  source: SessionTitleSource;
}

function normalizedTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = truncateTitle(value);
  return title || undefined;
}

/** Selects a title without comparing timestamps across unrelated sources. */
export function selectSessionTitle(
  input: SessionTitleSelectionInput,
): SessionTitleSelection | undefined {
  try {
    const explicit = normalizedTitle(input.explicit);
    if (explicit) return { title: explicit, source: 'explicit' };

    const parsedAnnotation = validAnnotation(input.annotation);
    const annotation = normalizedTitle(parsedAnnotation?.title);
    if (annotation) return { title: annotation, source: 'annotation' };

    const inferred = normalizedTitle(input.inferred);
    if (inferred) return { title: inferred, source: 'inferred' };
  } catch {
    // Candidate values can come from untrusted adapter boundaries.
  }
  return undefined;
}

function isAnnotation(value: unknown): value is SessionTitleAnnotationV1 {
  try {
    if (!value || typeof value !== 'object') return false;
    const record = asRecord(value);
    return (
      !!record &&
      record['version'] === 1 &&
      typeof record['sessionId'] === 'string' &&
      typeof record['updatedAt'] === 'string' &&
      typeof record['title'] === 'string'
    );
  } catch {
    return false;
  }
}

function cloneSummary(summary: SessionSummary): SessionSummary {
  try {
    return {
      sessionId: summary.sessionId,
      source: summary.source,
      ...(summary.agent && { agent: summary.agent }),
      ...(summary.host && { host: summary.host }),
      ...(summary.cwd && { cwd: summary.cwd }),
      ...(summary.worktree && { worktree: summary.worktree }),
      ...(summary.branch && { branch: summary.branch }),
      ...(summary.repo && { repo: { ...summary.repo } }),
      ...(summary.model && { model: summary.model }),
      ...(summary.permissionMode && { permissionMode: summary.permissionMode }),
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: summary.turns,
      toolCallCounts: { ...summary.toolCallCounts },
      tokens: { ...summary.tokens },
      ...(summary.lastToolCall && {
        lastToolCall: { ...summary.lastToolCall },
      }),
      ...(summary.title && { title: summary.title }),
      ...(summary.titleSource && { titleSource: summary.titleSource }),
      deliverables: {
        ...(summary.deliverables.branch && {
          branch: summary.deliverables.branch,
        }),
        prNumbers: [...summary.deliverables.prNumbers],
        commitShas: [...summary.deliverables.commitShas],
      },
      ...(summary.artifacts && { artifacts: [...summary.artifacts] }),
      ...(summary.totalCostUsd !== undefined && {
        totalCostUsd: summary.totalCostUsd,
      }),
      ...(summary.result && { result: { ...summary.result } }),
    };
  } catch {
    // A malformed legacy value must not let an annotation scan take down the
    // whole discovery pass. Keep cardinality stable with a detached empty
    // summary; well-formed summaries never use this path.
    return {
      sessionId: '',
      source: 'cli',
      startedAt: '',
      lastActivityAt: '',
      turns: 0,
      toolCallCounts: {},
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
    };
  }
}

function validAnnotation(value: unknown): SessionTitleAnnotationV1 | undefined {
  try {
    if (!isAnnotation(value)) return undefined;
    return parseSessionTitleAnnotationV1(value, value.sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Inner-joins validated annotation candidates onto discovered summaries.
 * Unknown ids are ignored and duplicate ids fail closed. Legacy summaries
 * without titleSource are treated as inferred, preserving old callers.
 */
export function joinSessionTitleAnnotations(
  summaries: readonly SessionSummary[],
  annotations: readonly SessionTitleAnnotationV1[],
): SessionSummary[] {
  const byId = new Map<string, SessionTitleAnnotationV1 | null>();
  for (const candidate of annotations) {
    const annotation = validAnnotation(candidate);
    if (!annotation) continue;
    if (byId.has(annotation.sessionId)) {
      byId.set(annotation.sessionId, null);
    } else {
      byId.set(annotation.sessionId, annotation);
    }
  }

  return summaries.map((original) => {
    const summary = cloneSummary(original);
    const annotation = byId.get(summary.sessionId);
    const selection =
      annotation &&
      selectSessionTitle({
        explicit:
          summary.titleSource === 'explicit' ? summary.title : undefined,
        annotation,
        inferred:
          summary.titleSource === 'explicit' ||
          summary.titleSource === 'annotation'
            ? undefined
            : summary.title,
      });
    if (
      selection &&
      (selection.source !== 'annotation' || summary.titleSource !== 'explicit')
    ) {
      summary.title = selection.title;
      summary.titleSource = selection.source;
    }
    return summary;
  });
}
