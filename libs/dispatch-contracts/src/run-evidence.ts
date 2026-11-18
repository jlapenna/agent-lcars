import { z } from 'zod';

/**
 * What a run's worker saw its agent do, read from the agent's own protocol
 * session rather than from a provider's transcript. Every harness that speaks
 * the Agent Client Protocol reports the same three things there: its tool
 * calls, its token usage and why the turn stopped.
 *
 * The record carries no text an agent, a model or a harness chose. Every
 * word in it comes from a closed list below, and the rest is numbers. A tool
 * call is its protocol kind, never its name, title or arguments, which can
 * hold a command, a path or a credential.
 *
 * It is also read leniently. A word outside its list becomes `other` and an
 * unknown key is dropped, so a worker newer than its Console still records
 * what that Console knows, and a Console rolled back still reads what a
 * newer one stored.
 */

/** How many tool calls a record lists; `toolCallCount` counts them all. */
export const RUN_EVIDENCE_TOOL_CALLS_MAX = 200;

/** The harnesses a claw image carries. */
export const RUN_EVIDENCE_HARNESSES = ['openclaw', 'claude', 'codex'] as const;
/** ACP's tool kinds. */
export const RUN_EVIDENCE_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
] as const;
/** ACP's tool call statuses. */
export const RUN_EVIDENCE_TOOL_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
] as const;
/** ACP's stop reasons. */
export const RUN_EVIDENCE_STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;

/** The currencies a harness's cost is recorded in. A cost in any other is
 * left out: a three-letter code is still a word somebody chose. */
export const RUN_EVIDENCE_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'CAD',
  'AUD',
  'CHF',
] as const;

/** One of `words`, or `other` for anything else. */
const word = <const T extends readonly [string, ...string[]]>(words: T) =>
  z.enum([...words, 'other']).catch('other');
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const runEvidenceToolCallSchema = z.object({
  kind: word(RUN_EVIDENCE_TOOL_KINDS),
  /** The last status the harness reported for the call. */
  status: word(RUN_EVIDENCE_TOOL_STATUSES),
});

export const runEvidenceUsageSchema = z.object({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  totalTokens: count.optional(),
  thoughtTokens: count.optional(),
  cachedReadTokens: count.optional(),
  cachedWriteTokens: count.optional(),
  /** Tokens in the model's context when the turn ended, and that context's
   * size. */
  contextTokens: count.optional(),
  contextWindow: count.optional(),
  /** What the harness itself said the session cost. A cost that is not an
   * amount in one of {@link RUN_EVIDENCE_CURRENCIES} is left out, and the
   * rest of the record stands. */
  cost: z
    .object({
      amount: z.number().min(0).max(1_000_000),
      currency: z.enum(RUN_EVIDENCE_CURRENCIES),
    })
    .optional()
    .catch(undefined),
});

const report = z.object({
  source: z.literal('acp'),
  /** The harness the session belonged to. */
  harness: word(RUN_EVIDENCE_HARNESSES),
  /** Why the harness ended the turn. Absent when the turn ended without the
   * harness answering the prompt. */
  stopReason: word(RUN_EVIDENCE_STOP_REASONS).optional(),
  /** Every tool call the session reported, listed or not. */
  toolCallCount: count,
  /** The first {@link RUN_EVIDENCE_TOOL_CALLS_MAX} calls, in the order they
   * started. */
  toolCalls: z
    .array(runEvidenceToolCallSchema)
    .max(RUN_EVIDENCE_TOOL_CALLS_MAX),
  usage: runEvidenceUsageSchema.optional(),
  /** From the prompt to the harness's answer to it, or to the end of a turn
   * that had none. */
  durationMs: count.optional(),
});
/** A record cannot list more calls than it counts. */
const counted = (record: { toolCallCount: number; toolCalls: unknown[] }) =>
  record.toolCallCount >= record.toolCalls.length;
const COUNTED = { message: 'toolCallCount is less than the calls listed' };

/** What a worker reports. */
export const runEvidenceReportSchema = report.refine(counted, COUNTED);
export type RunEvidenceReport = z.infer<typeof runEvidenceReportSchema>;

/** A report as it is stored and read back. */
export const runEvidenceSchema = report
  .extend({
    /** When the Console recorded it. */
    recordedAt: z.iso.datetime({ offset: false }).max(32),
  })
  .refine(counted, COUNTED);
export type RunEvidence = z.infer<typeof runEvidenceSchema>;
