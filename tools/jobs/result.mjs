import { z } from 'zod';

const evidence = z.string().min(1).max(4096);
export const resultSchema = z
  .strictObject({
    report: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
    findings: z.strictObject({
      version: z.literal(1),
      items: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(256),
            severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
            summary: z.string().min(1).max(4096),
            evidence: z.array(evidence).min(1).max(32),
            disposition: z.enum(['new', 'existing', 'resolved']),
          }),
        )
        .max(1000),
    }),
    coverage: z.strictObject({
      version: z.literal(1),
      scope: z.string().min(1).max(1024),
      checks: z
        .array(
          z.strictObject({
            name: z.enum([
              'discovery',
              'ports',
              'services',
              'baseline',
              'existing-issues',
            ]),
            status: z.enum(['complete', 'failed']),
            evidence: z.array(evidence).min(1).max(32),
          }),
        )
        .length(5),
    }),
  })
  .superRefine((value, context) => {
    if (new Set(value.coverage.checks.map((check) => check.name)).size !== 5) {
      context.addIssue({
        code: 'custom',
        message: 'each required coverage check must occur exactly once',
      });
    }
    if (
      new Set(value.findings.items.map((finding) => finding.key)).size !==
      value.findings.items.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'finding keys must be unique',
      });
    }
  });

export function validateResult(value, expectedScope) {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    throw new Error('result exceeds 1 MiB');
  const result = resultSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(result.findings)) > 48 * 1024)
    throw new Error('findings exceed prototype 48 KiB baseline bound');
  if (result.coverage.scope !== expectedScope)
    throw new Error('coverage scope does not match admitted scope');
  return {
    status: result.coverage.checks.every((check) => check.status === 'complete')
      ? 'succeeded'
      : 'incomplete',
    artifacts: {
      'report.md': result.report,
      'findings.json': result.findings,
      'coverage.json': result.coverage,
    },
  };
}
