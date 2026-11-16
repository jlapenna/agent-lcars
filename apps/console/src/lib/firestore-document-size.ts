/** Firestore's maximum document size. */
export const FIRESTORE_DOCUMENT_MAX_BYTES = 1024 * 1024;

const utf8 = (value: string) => new TextEncoder().encode(value).length;

/**
 * Firestore's documented storage size of a field value:
 * https://firebase.google.com/docs/firestore/storage-size
 */
function valueBytes(value: unknown): number {
  if (value === null || value === undefined || typeof value === 'boolean')
    return 1;
  if (typeof value === 'number' || value instanceof Date) return 8;
  if (typeof value === 'string') return utf8(value) + 1;
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + valueBytes(item), 0);
  if (typeof value === 'object')
    return Object.entries(value).reduce(
      (sum, [key, item]) =>
        item === undefined ? sum : sum + utf8(key) + 1 + valueBytes(item),
      0,
    );
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

/**
 * Storage size of a document at `path` (`collection/id[/collection/id...]`),
 * so a write can be refused with a clear reason before Firestore rejects it.
 */
export function firestoreDocumentBytes(path: string, data: object): number {
  // Name: each path segment plus 16 bytes, then the document's own 32 bytes.
  const name = path
    .split('/')
    .reduce((sum, segment) => sum + utf8(segment) + 1, 16);
  return name + valueBytes(data) + 32;
}

export function assertFirestoreDocumentFits(
  path: string,
  data: object,
  what: string,
): void {
  const bytes = firestoreDocumentBytes(path, data);
  if (bytes > FIRESTORE_DOCUMENT_MAX_BYTES)
    throw new Error(
      `${what} is ${bytes} bytes, above Firestore's ${FIRESTORE_DOCUMENT_MAX_BYTES}-byte document limit`,
    );
}
