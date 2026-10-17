import type { HumanNeededActions } from '@agent-lcars/dispatch-contracts';
import { Code, Stack, Text } from '@mantine/core';

/** Model text stays inert; commands are copyable excerpts, never controls. */
export function HumanNeededSummary({
  actions,
}: {
  actions?: HumanNeededActions;
}) {
  if (!actions?.length) return null;
  return (
    <Stack gap={4} component="section" aria-label="Human work summary">
      <Text size="sm" fw={600}>
        Human work · AI summary
      </Text>
      <ul
        style={{
          margin: 0,
          paddingInlineStart: '1.25rem',
          overflowWrap: 'anywhere',
        }}
      >
        {actions.map((action, index) => (
          <li key={index}>
            <Text size="sm">{action.text}</Text>
            {action.command && (
              <Code
                block
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {action.command}
              </Code>
            )}
          </li>
        ))}
      </ul>
    </Stack>
  );
}
