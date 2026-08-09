/**
 * The server-to-client serialization boundary for Firestore-derived values.
 *
 * Keep this module server-only: callers use it immediately before passing data
 * to a Client Component. It deliberately returns only JSON/RSC-safe values,
 * rather than trusting Firestore document data to be a plain object.
 */
export type ClientValue =
  | null
  | boolean
  | number
  | string
  | ClientValue[]
  | { [key: string]: ClientValue };

const DEFAULT_EXCLUDED_KEYS = ['metadata'];

interface ForClientOptions {
  /** Keys to omit at every depth; operational metadata is never client data. */
  excludeKeys?: readonly string[];
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value: Record<string, unknown>): boolean {
  return (
    typeof value['seconds'] === 'number' &&
    typeof value['nanoseconds'] === 'number' &&
    typeof value['toDate'] === 'function'
  );
}

function isDocumentReference(value: Record<string, unknown>): boolean {
  return (
    typeof value['path'] === 'string' &&
    typeof value['id'] === 'string' &&
    typeof value['get'] === 'function'
  );
}

function isGeoPoint(value: Record<string, unknown>): boolean {
  return (
    typeof value['latitude'] === 'number' &&
    typeof value['longitude'] === 'number' &&
    typeof value['isEqual'] === 'function'
  );
}

function isVectorValue(value: Record<string, unknown>): boolean {
  return typeof value['toArray'] === 'function';
}

/**
 * Converts Firestore values to a safe RSC transport value.
 *
 * Timestamp-like values are detected structurally because firebase-admin and
 * @google-cloud/firestore can provide distinct class identities at runtime.
 * Unknown class instances are dropped rather than allowed across the boundary.
 */
export function forClient(
  value: unknown,
  options: ForClientOptions = {},
): ClientValue | undefined {
  const excludedKeys = new Set(options.excludeKeys ?? DEFAULT_EXCLUDED_KEYS);
  const visited = new WeakSet<object>();

  const visit = (candidate: unknown): ClientValue | undefined => {
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'number' ||
      typeof candidate === 'boolean'
    ) {
      return candidate;
    }
    if (typeof candidate !== 'object') return undefined;
    if (candidate instanceof Date) return candidate.toISOString();

    const record = candidate as Record<string, unknown>;
    if (isTimestamp(record)) {
      return (record['toDate'] as () => Date)().toISOString();
    }
    if (isDocumentReference(record)) {
      return {
        path: record['path'] as string,
        id: record['id'] as string,
        __type: 'DocumentReference',
      };
    }
    if (isGeoPoint(record)) {
      return {
        latitude: record['latitude'] as number,
        longitude: record['longitude'] as number,
        __type: 'GeoPoint',
      };
    }
    if (isVectorValue(record)) {
      const values = (record['toArray'] as () => unknown[])();
      return values.every((entry) => typeof entry === 'number')
        ? (values as number[])
        : undefined;
    }
    if (!Array.isArray(candidate) && !isPlainObject(candidate)) {
      return undefined;
    }
    if (visited.has(candidate)) return '[Circular]';
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      const result: ClientValue[] = [];
      for (const entry of candidate) {
        const dehydrated = visit(entry);
        if (dehydrated !== undefined) result.push(dehydrated);
      }
      return result;
    }

    const result: { [key: string]: ClientValue } = {};
    for (const [key, entry] of Object.entries(candidate)) {
      if (excludedKeys.has(key)) continue;
      const dehydrated = visit(entry);
      if (dehydrated !== undefined) result[key] = dehydrated;
    }
    return result;
  };

  return visit(value);
}
