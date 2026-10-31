// Kept apart from spec.ts: Client Components import this, and spec.ts's
// top-level zod schemas would otherwise ship the validator to the browser
// (#2201).
export function workRepository(spec: {
  pipeline: string;
  target?: { repo: string };
}): string {
  return spec.target?.repo ?? '';
}
