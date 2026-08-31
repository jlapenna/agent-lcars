/**
 * The one-shot schema migration needs enough existing context for an operator
 * to prepare an evidence-backed manifest. Keep this projection deliberately
 * narrow: it is not a second session reader and never derives a provider,
 * repository, or archive location from another field.
 */
export interface SessionSchemaInventoryProvenance {
  archivePresent: boolean;
  source?: unknown;
  agent?: unknown;
  repo?: unknown;
  host?: unknown;
  cwd?: unknown;
  worktree?: unknown;
  runId?: unknown;
  intentId?: unknown;
  issueNumber?: unknown;
  renderable?: unknown;
  lastActivityAt?: unknown;
}

type StoredDocument = Record<string, unknown>;

function isStoredDocument(value: unknown): value is StoredDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedField(
  document: StoredDocument,
  field: string,
): Record<string, unknown> {
  return Object.hasOwn(document, field) ? { [field]: document[field] } : {};
}

function archivePresent(document: StoredDocument): boolean {
  const archive = document['transcriptGcsUri'];
  return typeof archive === 'string' && archive.trim().length > 0;
}

/**
 * Returns only stored operator-review provenance for one migration record.
 * `archivePresent` intentionally replaces the opaque archive URI. The
 * source-specific fields are emitted only when the stored source explicitly
 * identifies that source; nothing is inferred for malformed legacy records.
 */
export function sessionSchemaInventoryProvenance(
  document: unknown,
): SessionSchemaInventoryProvenance {
  if (!isStoredDocument(document)) return { archivePresent: false };

  const source = document['source'];
  return {
    ...storedField(document, 'source'),
    ...storedField(document, 'agent'),
    ...storedField(document, 'repo'),
    ...(source === 'cli' && storedField(document, 'host')),
    ...(source === 'cli' && storedField(document, 'cwd')),
    ...(source === 'cli' && storedField(document, 'worktree')),
    ...(source === 'issue-agent' && storedField(document, 'runId')),
    ...(source === 'issue-agent' && storedField(document, 'intentId')),
    ...(source === 'issue-agent' && storedField(document, 'issueNumber')),
    archivePresent: archivePresent(document),
    ...storedField(document, 'renderable'),
    ...storedField(document, 'lastActivityAt'),
  };
}
