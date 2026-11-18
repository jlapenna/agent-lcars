import type { ItemRunView } from '@agent-lcars/work/derive';
import { Stack, Text } from '@mantine/core';

type Evidence = NonNullable<ItemRunView['evidence']>;

// One locale on the server and in the browser, so the two render the same.
const number = (value: number) => value.toLocaleString('en-US');

/** `execute 2, read 1`, in the order each kind was first used. */
function byKind(calls: Evidence['toolCalls']): string {
  const counts = new Map<string, number>();
  for (const call of calls)
    counts.set(call.kind, (counts.get(call.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${kind} ${count}`).join(', ');
}

function toolLine(evidence: Evidence): string {
  if (evidence.toolCallCount === 0) return 'Tool calls: none';
  const failed = evidence.toolCalls.filter(
    (call) => call.status === 'failed',
  ).length;
  const unfinished = evidence.toolCalls.filter(
    (call) => call.status !== 'failed' && call.status !== 'completed',
  ).length;
  const notes = [
    ...(evidence.toolCalls.length === 0 ? [] : [byKind(evidence.toolCalls)]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(unfinished === 0 ? [] : [`${unfinished} unfinished`]),
    ...(evidence.toolCalls.length > 0 &&
    evidence.toolCallCount > evidence.toolCalls.length
      ? [`first ${evidence.toolCalls.length} listed`]
      : []),
  ];
  const total = `Tool calls: ${number(evidence.toolCallCount)}`;
  return notes.length === 0 ? total : `${total} (${notes.join('; ')})`;
}

/** A cost too small for four decimals is still not nothing. */
function cost(amount: number): string {
  return amount > 0 && amount < 0.00005 ? 'under 0.0001' : amount.toFixed(4);
}

function usageParts(usage: Evidence['usage']): string[] {
  if (usage === undefined) return [];
  const named: [number | undefined, string][] = [
    [usage.inputTokens, 'in'],
    [usage.outputTokens, 'out'],
    [usage.cachedReadTokens, 'cached'],
    [usage.cachedWriteTokens, 'written to cache'],
    [usage.thoughtTokens, 'thinking'],
  ];
  const tokens = named.flatMap(([value, name]) =>
    value === undefined ? [] : [`${number(value)} ${name}`],
  );
  return [
    ...(tokens.length === 0
      ? usage.totalTokens === undefined
        ? []
        : [`Tokens: ${number(usage.totalTokens)}`]
      : [`Tokens: ${tokens.join(', ')}`]),
    ...(usage.contextTokens === undefined
      ? usage.contextWindow === undefined
        ? []
        : [`Context window: ${number(usage.contextWindow)}`]
      : [
          `Context: ${number(usage.contextTokens)}${
            usage.contextWindow === undefined
              ? ''
              : ` of ${number(usage.contextWindow)}`
          }`,
        ]),
    ...(usage.cost === undefined
      ? []
      : [`Cost: ${usage.cost.currency} ${cost(usage.cost.amount)}`]),
  ];
}

/** Whole seconds, or tenths for a turn shorter than ten of them. */
function seconds(durationMs: number): string {
  const value = durationMs / 1000;
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** What the run's worker saw its agent do: tool calls by kind, why the turn
 *  stopped and what it used. Read from the agent's protocol session, so it
 *  is the same for every harness. Every word shown is from a closed list;
 *  none is the agent's own. */
export function RunEvidenceSummary({
  run,
}: {
  run: Pick<ItemRunView, 'evidence'>;
}) {
  const evidence = run.evidence;
  if (evidence === undefined) return null;
  const turn = [
    `Harness: ${evidence.harness}`,
    ...(evidence.stopReason === undefined
      ? []
      : [`Stopped: ${evidence.stopReason}`]),
    ...usageParts(evidence.usage),
    ...(evidence.durationMs === undefined
      ? []
      : [`Turn: ${seconds(evidence.durationMs)} s`]),
  ];
  return (
    <Stack gap={2} data-testid="run-evidence">
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {toolLine(evidence)}
      </Text>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {turn.join(' · ')}
      </Text>
    </Stack>
  );
}
