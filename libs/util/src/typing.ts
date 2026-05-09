export const assertType = <T>(x: T) => x;

export function stringOrUndefined(value: string | number): string | undefined {
  return value ? value.toString() : undefined;
}

export function valueOrUndefined<T>(value: T): T | undefined {
  return value ? value : undefined;
}

export type KnownKeys<T> = keyof {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : K]: unknown;
};

/** Undefined Type Guard */
export function isDefined<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

export function assertDefined<T>(value: T): NonNullable<T> {
  if (isDefined(value)) {
    return value;
  } else {
    throw new Error('value provided was undefined');
  }
}

/** Undefined Type Guard */
export function isString(value: unknown): value is string {
  return (
    value !== null && (typeof value === 'string' || value instanceof String)
  );
}

export function isBrowser(): boolean {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return false;
  }
  return 'window' in globalThis;
}

export function assertNotBrowser(): void {
  if (isBrowser()) {
    throw new Error(
      'This module cannot be imported from a Client Component. It should only be used from a Server Component or Node.js environment.',
    );
  }
}
