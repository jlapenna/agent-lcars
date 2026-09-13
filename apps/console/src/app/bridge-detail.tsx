import { Anchor, Card, Stack, Text, Title } from '@mantine/core';

import { ActionItemCard } from './action-item-card';
import {
  CliSessionRow,
  FinishedRunRow,
  LiveRunRow,
} from './agent-activity-panel';
import type { BridgeDetail as BridgeDetailDescriptor } from './bridge-rows';
import { bridgeSelectionHref } from './bridge-selection';

/**
 * The Bridge's right-hand detail pane. It renders whatever the `?sel=`-keyed
 * row resolved to on the server (`resolveBridgeDetail`), reusing the exact
 * detail-variant renderers the operational rows already speak - an in-flight
 * or finished run gets its full budget/conclusion view, a CLI session gets its
 * host/artifact view, a deploy-wait item gets the same workspace card the Inbox
 * uses. Selection is a link (not state), so the pane is server-rendered and no
 * client boundary is needed to show it.
 *
 * On phones there is no second column, so the "back" control is the only way
 * out of a selected row - it renders for every kind, including the item card,
 * which supplies no back affordance of its own.
 */
export function BridgeDetail({
  detail,
  repoFilterKey,
}: {
  detail: BridgeDetailDescriptor;
  repoFilterKey?: string;
}) {
  if (detail.kind === 'none') {
    return (
      <div className="bridge-detail-state" data-testid="bridge-detail-empty">
        <Title order={2} size="h3">
          No row selected
        </Title>
        <Text c="dimmed" size="sm">
          Select any row - a run, a session, or an item waiting on deploy - to
          see its full detail here without leaving the Bridge.
        </Text>
      </div>
    );
  }

  const backHref = bridgeSelectionHref(undefined, repoFilterKey);
  const eyebrow =
    detail.kind === 'item'
      ? 'Waiting on deploy'
      : detail.kind === 'liveRun'
        ? 'In flight'
        : detail.kind === 'recentRun'
          ? 'Latest outcome'
          : 'CLI session';

  return (
    <div className="bridge-detail" data-testid="bridge-detail">
      <div className="bridge-detail__bar">
        <Anchor href={backHref} size="sm" className="bridge-detail-back">
          ← All activity
        </Anchor>
        <Text size="xs" c="dimmed" className="bridge-detail__scope">
          {eyebrow}
        </Text>
      </div>
      {detail.kind === 'item' ? (
        <ActionItemCard
          item={detail.card.item}
          primaryAction={detail.card.primaryAction}
          multiRepo={detail.multiRepo}
          muted={false}
          variant="workspace"
        />
      ) : (
        <Card
          withBorder
          padding="md"
          className="lcars-panel bridge-detail-card"
        >
          <Stack gap="sm">
            {detail.kind === 'liveRun' && (
              <LiveRunRow
                run={detail.run}
                item={detail.item}
                session={detail.session}
                variant="detail"
              />
            )}
            {detail.kind === 'recentRun' && (
              <FinishedRunRow
                run={detail.run}
                session={detail.session}
                variant="detail"
              />
            )}
            {detail.kind === 'session' && (
              <CliSessionRow session={detail.session} variant="detail" />
            )}
          </Stack>
        </Card>
      )}
    </div>
  );
}
