import { Button, Group } from '@mantine/core';

import type { HumanDecision } from '../lib/human-ask';

export function HumanDecisionButtons({
  decision,
  disabled,
  onChoose,
}: {
  decision: HumanDecision;
  disabled: boolean;
  onChoose: (choice: HumanDecision['choices'][number]) => void;
}) {
  if (!decision.choices.length) return null;
  return (
    <Group gap="xs" role="group" aria-label="Answer the agent">
      {decision.choices.map((choice) => (
        <Button
          key={choice.label}
          size="xs"
          variant={choice.kind === 'approval' ? 'filled' : 'default'}
          disabled={disabled}
          onClick={() => onChoose(choice)}
        >
          {choice.label}
        </Button>
      ))}
    </Group>
  );
}
