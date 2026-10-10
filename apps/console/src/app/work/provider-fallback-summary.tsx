import type { ItemRunView } from '@agent-lcars/work/derive';
import { Stack, Text } from '@mantine/core';

export function ProviderFallbackSummary({
  run,
}: {
  run: Pick<ItemRunView, 'pipeline' | 'providerFallback'>;
}) {
  const policy = run.providerFallback;
  if (policy === undefined) return null;
  return (
    <Stack gap={2} data-testid="provider-fallback">
      <Text size="xs" c="dimmed">
        Allowed fallback order: {policy.allowedPipelines.join(' → ')}
      </Text>
      {policy.trigger !== undefined && (
        <>
          <Text size="xs">
            Fresh attempt on {run.pipeline}: {policy.trigger.limitedPipeline}{' '}
            {policy.trigger.reason === 'provider-limit'
              ? 'reported a provider limit'
              : 'is cooling down'}
            .
          </Text>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            Original intent: {policy.originalRunId}; previous attempt:{' '}
            {policy.fromRunId}; triggering failure:{' '}
            {policy.trigger.failureRunId}.
          </Text>
        </>
      )}
    </Stack>
  );
}
