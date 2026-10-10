/** Opaque durable references; callers must still apply safeHttpUrl per value. */
export function resultRefs(
  result: { ref?: string; relatedRefs?: string[] } | undefined,
): string[] {
  return [
    ...new Set(
      [result?.ref, ...(result?.relatedRefs ?? [])].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
}
