export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Recursively collects every string leaf out of an arbitrarily-shaped value. */
export function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const nested of Object.values(record)) {
      collectStrings(nested, out);
    }
    return;
  }
  const array = asArray(value);
  if (array) {
    for (const nested of array) {
      collectStrings(nested, out);
    }
  }
}
