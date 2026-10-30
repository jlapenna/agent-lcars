import { z } from 'zod';

import { type JobDefinition, jobDigest } from './repository-job-definition';
import type { JobArtifact } from './repository-job-store';

// A model can return a schema-shaped stub instead of what it found. A stub
// must fail the run, not become the next run's baseline.
const stub = /^(?:placeholder|todo|tbd|\.\.\.|…|<[^>]*>)$/iu;
const substantive = (value: string) => !stub.test(value.trim());
const report = z
  .string()
  .trim()
  .min(1)
  .max(65536)
  .refine(substantive, 'Placeholder text');
const evidence = z
  .array(z.string().min(1).max(4096).refine(substantive, 'Placeholder text'))
  .min(1)
  .max(32);
const securityResult = z.strictObject({
  report,
  findings: z.strictObject({
    version: z.literal(1),
    items: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(256),
          severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
          summary: z
            .string()
            .min(1)
            .max(4096)
            .refine(substantive, 'Placeholder text'),
          evidence,
          disposition: z.enum(['new', 'existing', 'resolved']),
        }),
      )
      .max(1000),
  }),
  coverage: z.strictObject({
    version: z.literal(1),
    scope: z.string(),
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
          evidence,
        }),
      )
      .length(5),
  }),
});
export function validateJobResult(
  definition: JobDefinition,
  value: unknown,
): JobArtifact {
  if (Buffer.byteLength(JSON.stringify(value)) > 262144)
    throw new Error('Result exceeds 256 KiB');
  let artifacts: Record<string, unknown>;
  let baseline: unknown;
  let successful: boolean;
  if (definition.job.result.contract === 'security-audit-v1') {
    const result = securityResult.parse(value);
    if (
      result.coverage.scope !== definition.job.inputs['subnet'] ||
      new Set(result.coverage.checks.map((check) => check.name)).size !== 5 ||
      new Set(result.findings.items.map((finding) => finding.key)).size !==
        result.findings.items.length
    )
      throw new Error('Result scope, coverage, or finding identity mismatch');
    artifacts = {
      'report.md': result.report,
      'findings.json': result.findings,
      'coverage.json': result.coverage,
    };
    baseline = result.findings;
    successful = result.coverage.checks.every(
      (check) => check.status === 'complete',
    );
  } else {
    const result = z
      .strictObject({
        report,
        complete: z.boolean(),
        data: z.record(z.string(), z.unknown()),
      })
      .parse(value);
    artifacts = { 'report.md': result.report, 'result.json': result.data };
    baseline = result.data;
    successful = result.complete;
  }
  if (Buffer.byteLength(JSON.stringify(baseline)) > 49152)
    throw new Error('Baseline exceeds 48 KiB');
  return {
    digest: jobDigest([successful, artifacts]),
    successful,
    artifacts,
    baseline,
  };
}
