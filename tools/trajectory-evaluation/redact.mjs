import assert from 'node:assert/strict';

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|oauth|password|private[-_]?key|secret|token|api[-_]?key)/iu;
const SENSITIVE_VALUES = [
  /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

function redactString(value) {
  let redacted = value;
  for (const pattern of SENSITIVE_VALUES)
    redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted;
}

export function redactRecord(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactRecord(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactRecord(child, childKey),
      ]),
    );
  }
  return value;
}

export function assertPrivacySafe(corpus) {
  const serialized = JSON.stringify(corpus);
  for (const pattern of SENSITIVE_VALUES) {
    pattern.lastIndex = 0;
    assert(
      !pattern.test(serialized),
      `corpus contains a credential-shaped value matching ${pattern}`,
    );
  }
  for (const entry of corpus.entries ?? []) {
    if (entry.repositoryVisibility === 'private') {
      assert.equal(
        entry.anchor?.snapshot?.availability,
        'reference-only',
        `${entry.id} embeds private repository content`,
      );
    }
    for (const archive of entry.trajectory?.archiveRefs ?? []) {
      assert.equal(
        archive.access,
        'protected',
        `${entry.id} trajectory archive must remain protected`,
      );
      assert(
        !('content' in archive),
        `${entry.id} trajectory archive must be a reference, not content`,
      );
    }
  }
}
