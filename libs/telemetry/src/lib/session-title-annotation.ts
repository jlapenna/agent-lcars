import { parseV1TextFieldEnvelope } from './v1-text-envelope';

/** Closed v1 envelope for an untrusted local session-title candidate. This is
 * intentionally only a parser contract: it does not select, join, or persist
 * a title. */
export interface SessionTitleAnnotationV1 {
  version: 1;
  sessionId: string;
  updatedAt: string;
  title: string;
}

/**
 * Validates the only supported local annotation shape. The filename-derived
 * id is part of the envelope boundary: accepting a different id would allow
 * one final file to claim another session's title.
 *
 * A thin `title`-field instantiation of the shared
 * `parseV1TextFieldEnvelope` helper (issue #1257) — see that module's doc
 * comment for why the four-key closed check, ISO-timestamp validation, and
 * `isSafeIdentifier`/`truncateTitle` normalization live there instead of
 * here. This function's own behaviour is unchanged by that split: same
 * accepted/rejected shapes, same normalization, same return type.
 */
export function parseSessionTitleAnnotationV1(
  value: unknown,
  filenameSessionId: string,
): SessionTitleAnnotationV1 | undefined {
  return parseV1TextFieldEnvelope(value, filenameSessionId, 'title');
}
