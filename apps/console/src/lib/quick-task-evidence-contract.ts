import type { RepositoryRef } from './watched-repo';

/** The only multipart fields accepted by the future Quick Task upload route. */
export const QUICK_TASK_MULTIPART_FIELDS = {
  intent: 'intent',
  evidence: 'evidence',
} as const;

export const QUICK_TASK_EVIDENCE_SCHEMA_VERSION = 'v1';
export const QUICK_TASK_EVIDENCE_ROUTE_PREFIX =
  '/api/quick-task-evidence/v1/' as const;
export const QUICK_TASK_EVIDENCE_OBJECT_PREFIX = 'objects/v1/' as const;
export const QUICK_TASK_EVIDENCE_REVOCATION_PREFIX = 'revocations/v1/' as const;

export const QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const QUICK_TASK_EVIDENCE_MAX_PIXELS = 25_000_000;
export const QUICK_TASK_EVIDENCE_MAX_DIMENSION = 10_000;
export const QUICK_TASK_EVIDENCE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export const QUICK_TASK_EVIDENCE_OUTPUT_MIME_TYPE = 'image/webp' as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** A non-secret bearer identifier. Never put this value in application logs. */
export type QuickTaskEvidenceId = string;

export interface QuickTaskEvidenceIntent {
  requestId: string;
  evidenceId?: QuickTaskEvidenceId;
  repository: RepositoryRef;
  pipeline: string;
  description: string;
  source: {
    route: string;
    identities: string;
    capturedAt: string;
    deployment?: string;
  };
}

/** Immutable metadata written with the normalized evidence object. */
export interface QuickTaskEvidenceBinding {
  schemaVersion: typeof QUICK_TASK_EVIDENCE_SCHEMA_VERSION;
  evidenceId: QuickTaskEvidenceId;
  requestId: string;
  repositoryId: number;
  normalizedSha256: string;
  visibilityAtUpload: 'public' | 'private' | 'internal';
  createdAt: string;
}

export interface QuickTaskNormalizedEvidence {
  bytes: Uint8Array;
  contentType: typeof QUICK_TASK_EVIDENCE_OUTPUT_MIME_TYPE;
  sha256: string;
  width: number;
  height: number;
}

export interface QuickTaskEvidenceObject {
  binding: QuickTaskEvidenceBinding;
  generation: string;
}

/** Frozen seam: called only by the winning Quick Task claimant before create. */
export interface QuickTaskEvidencePreIssueCreateHook {
  prepare(input: {
    intent: QuickTaskEvidenceIntent;
    repositoryId: number;
    visibility: QuickTaskEvidenceBinding['visibilityAtUpload'];
  }): Promise<QuickTaskEvidenceObject | undefined>;
  rollbackDefinitiveCreateFailure(
    evidence: QuickTaskEvidenceObject,
  ): Promise<void>;
}

/** Server-only adapter; it must never list objects or expose object paths. */
export interface QuickTaskEvidenceStore {
  create(
    evidence: QuickTaskNormalizedEvidence,
    binding: QuickTaskEvidenceBinding,
  ): Promise<QuickTaskEvidenceObject>;
  read(evidenceId: QuickTaskEvidenceId): Promise<Uint8Array | undefined>;
  readObject(
    evidenceId: QuickTaskEvidenceId,
  ): Promise<QuickTaskEvidenceObject | undefined>;
  isRevoked(evidenceId: QuickTaskEvidenceId): Promise<boolean>;
  tombstone(binding: QuickTaskEvidenceBinding): Promise<void>;
  deleteGeneration(
    evidenceId: QuickTaskEvidenceId,
    generation: string,
  ): Promise<void>;
}

export type QuickTaskEvidenceLifecycleDisposition =
  | 'none'
  | 'release-claim'
  | 'delete-created-generation'
  | 'retain-for-reconciliation';

export type QuickTaskEvidenceErrorStatus =
  400 | 401 | 404 | 409 | 413 | 415 | 422 | 503;

/** Public messages are deliberately generic: evidence IDs are bearer capabilities. */
export class QuickTaskEvidenceError extends Error {
  constructor(
    public readonly statusCode: QuickTaskEvidenceErrorStatus,
    message = 'Quick Task evidence could not be processed',
  ) {
    super(message);
  }
}

export interface QuickTaskEvidenceReadResponse {
  status: 200 | 404;
  headers: Readonly<Record<string, string>>;
}

export const QUICK_TASK_EVIDENCE_RESPONSE_HEADERS = {
  'Cache-Control': 'no-cache, max-age=0',
  'Content-Disposition': 'inline; filename="screenshot.webp"',
  'Content-Type': QUICK_TASK_EVIDENCE_OUTPUT_MIME_TYPE,
  'X-Content-Type-Options': 'nosniff',
} as const;

export const QUICK_TASK_EVIDENCE_NOT_FOUND_RESPONSE: QuickTaskEvidenceReadResponse =
  {
    status: 404,
    headers: {},
  };

export const QUICK_TASK_EVIDENCE_SUCCESS_RESPONSE: QuickTaskEvidenceReadResponse =
  {
    status: 200,
    headers: QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
  };

export function isQuickTaskEvidenceId(value: string): boolean {
  return UUID_V4.test(value);
}

export function quickTaskEvidenceObjectKey(
  evidenceId: QuickTaskEvidenceId,
): string {
  if (!isQuickTaskEvidenceId(evidenceId)) {
    throw new QuickTaskEvidenceError(400, 'Invalid evidence identifier');
  }
  return `${QUICK_TASK_EVIDENCE_OBJECT_PREFIX}${evidenceId}.webp`;
}

export function quickTaskEvidenceRevocationKey(
  evidenceId: QuickTaskEvidenceId,
): string {
  if (!isQuickTaskEvidenceId(evidenceId)) {
    throw new QuickTaskEvidenceError(400, 'Invalid evidence identifier');
  }
  return `${QUICK_TASK_EVIDENCE_REVOCATION_PREFIX}${evidenceId}`;
}

/** Derive from trusted deployment configuration, never an HTTP Host header. */
export function quickTaskEvidenceUrl(
  trustedOrigin: string,
  evidenceId: QuickTaskEvidenceId,
): string {
  if (!isQuickTaskEvidenceId(evidenceId)) {
    throw new QuickTaskEvidenceError(400, 'Invalid evidence identifier');
  }
  let origin: URL;
  try {
    origin = new URL(trustedOrigin);
  } catch {
    throw new QuickTaskEvidenceError(503, 'Evidence origin is unavailable');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password) {
    throw new QuickTaskEvidenceError(503, 'Evidence origin is unavailable');
  }
  origin.pathname = `${origin.pathname.replace(/\/$/u, '')}${QUICK_TASK_EVIDENCE_ROUTE_PREFIX}${evidenceId}`;
  origin.search = '';
  origin.hash = '';
  return origin.toString();
}

export function quickTaskEvidenceMarkdown(
  trustedOrigin: string,
  evidenceId: QuickTaskEvidenceId,
): string {
  return `![Screenshot](${quickTaskEvidenceUrl(trustedOrigin, evidenceId)})`;
}

export const QUICK_TASK_EVIDENCE_DISCLOSURE_WARNING =
  'This screenshot is stored outside GitHub repository access controls. Anyone who obtains the LCARS or GitHub-proxy image link can view and forward it, even after losing repository access. If this repository is or becomes public, the screenshot is public. GitHub and other readers may cache copies. Do not upload secrets or sensitive data.';
