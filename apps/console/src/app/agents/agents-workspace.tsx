import type { ReactNode } from 'react';

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
}: {
  warnings?: ReactNode;
  fleet: ReactNode;
  active: ReactNode;
  claimedIdle: ReactNode;
  recentOutcomes: ReactNode;
}) {
  return (
    <section
      className="console-workspace agents-workspace"
      aria-label="Agent operations"
    >
      {warnings && <div className="agents-workspace__warnings">{warnings}</div>}
      {fleet}
      <div className="agents-workspace__operations">
        <div className="agents-workspace__primary">{active}</div>
        <div className="agents-workspace__secondary">
          {claimedIdle}
          {recentOutcomes}
        </div>
      </div>
    </section>
  );
}
