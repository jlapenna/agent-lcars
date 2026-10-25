import type { HumanNeededActions } from '@agent-lcars/dispatch-contracts';
import { Code, Stack, Text } from '@mantine/core';

/** Model text stays inert; commands are copyable excerpts, never controls. */
export function HumanNeededSummary({
  actions,
  historical = false,
}: {
  actions?: HumanNeededActions;
  historical?: boolean;
}) {
  if (!actions?.length) return null;
  const summary = (
    <Stack gap={4} component="section" aria-label="Human work summary">
      <Text size="sm" fw={600}>
        {historical
          ? 'Actions requested when this run parked'
          : 'Human work · AI summary'}
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
  if (!historical) return summary;
  return (
    <details className="lcars-disclosure">
      <summary className="lcars-disclosure__summary">
        Earlier handoff · AI summary
      </summary>
      <div className="lcars-disclosure__content">
        <Text size="xs" c="dimmed">
          Saved when this run parked. Later comments may supersede these
          actions; check the latest original context before acting.
        </Text>
        {summary}
      </div>
    </details>
  );
}
