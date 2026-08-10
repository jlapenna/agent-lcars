import type { ReactNode } from 'react';

import { ConsoleWorkspace } from '../console-workspace';

/**
 * Responsive composition for the agent-focused route. Data fetching and
 * classification stay in page.tsx; this component only establishes the
 * operational hierarchy shared by every data state.
 */
export function AgentsWorkspace({
  warnings,
  fleet,
  active,
  claimedIdle,
  recentOutcomes,
  hasSecondary = true,
}: {
  warnings?: ReactNode;
  fleet: ReactNode;
  active: ReactNode;
  claimedIdle: ReactNode;
  recentOutcomes: ReactNode;
  /** Empty secondary panels are omitted on the source page; do not reserve a
   * desktop column or a mobile viewport slice for them. */
  hasSecondary?: boolean;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel="Agent operations"
      className="agents-workspace"
      warnings={warnings}
    >
      {fleet}
      <div className="agents-workspace__operations">
        <div className="agents-workspace__primary">{active}</div>
        {hasSecondary && (
          <div className="agents-workspace__secondary">
            {claimedIdle}
            {recentOutcomes}
          </div>
        )}
      </div>
    </ConsoleWorkspace>
  );
}
