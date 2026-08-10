import { Stack, Text } from '@mantine/core';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getAutoscalerStatuses } from '../../lib/autoscaler-status';
import { ConsoleHeader, DataWarnings } from '../console-header';
import { ConsolePageShell } from '../console-page-shell';
import { RunnerAutoscalerStatus } from '../runner-autoscaler-status';

export default async function ShuttlebayPage() {
  assertAdmin(await auth(), '/login');
  const autoscaler = await getAutoscalerStatuses();
  return (
    <ConsolePageShell>
      <ConsoleHeader
        current="shuttlebay"
        title="Shuttlebay"
        subtitle="Live runner fleet and queue status"
      />
      <DataWarnings warnings={autoscaler.warnings} />
      <Stack gap="md">
        <Text c="dimmed" size="sm">
          Refreshes automatically every 10 seconds.
        </Text>
        <RunnerAutoscalerStatus initial={autoscaler} />
      </Stack>
    </ConsolePageShell>
  );
}
