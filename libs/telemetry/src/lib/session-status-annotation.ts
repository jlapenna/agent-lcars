import { parseV1TextFieldEnvelope } from './v1-text-envelope';

/**
 * Closed v1 envelope for an untrusted local session-status candidate —
 * `lcars session status "<text>"` (issue #1257). Deliberately its OWN
 * envelope, not a v2 of {@link SessionTitleAnnotationV1}: a title is the
 * session's stable NAME, a status is what it is doing RIGHT NOW, and the two
 * have separate lifetimes. Folding status into the title envelope would make
 * `lcars session status` a read-modify-write against the same file
 * `lcars session title` writes, racing a concurrent title update — see
 * `session-title-paths.ts`'s `STATUS_SUBDIRECTORY` for why this gets its own
 * channel directory for the same reason. This is intentionally only a
 * parser contract: it does not select, join, or persist a status.
 */
export interface SessionStatusAnnotationV1 {
  version: 1;
  sessionId: string;
  updatedAt: string;
  status: string;
}

/**
 * Validates the only supported local status-annotation shape. The
 * filename-derived id is part of the envelope boundary: accepting a
 * different id would allow one final file to claim another session's
 * status.
 *
 * A thin `status`-field instantiation of the shared
 * `parseV1TextFieldEnvelope` helper — same four-key closed validation, same
 * `isSafeIdentifier` + `truncateTitle` normalization, as
 * `parseSessionTitleAnnotationV1` in `session-title-annotation.ts`.
 */
export function parseSessionStatusAnnotationV1(
  value: unknown,
  filenameSessionId: string,
): SessionStatusAnnotationV1 | undefined {
  return parseV1TextFieldEnvelope(value, filenameSessionId, 'status');
}
