/**
 * Stringifies an object, handling BigInt values as raw JSON numbers.
 */
export function stringifyWithBigInt(
  obj: unknown,
  space: string | number | undefined = 2,
): string {
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'bigint') {
        // JSON.rawJSON prevents the stringifier from adding quotes
        // or throwing a TypeError.
        // @ts-expect-error JSON.rawJSON is a new feature
        return JSON.rawJSON(value.toString());
      }
      return value;
    },
    space,
  );
}
