import type { ReactNode } from 'react';

import { ConsoleWorkspace } from '../console-workspace';

/**
 * Route-level composition for the runner fleet.
 *
 * Shuttlebay was the one primary destination that never adopted the shared
 * frame: it rendered a bare stack of bordered cards straight onto the page
 * ground, so it had no workspace edge, no warning band, and no toolbar while
 * every neighbouring route had all three (#1828). Data fetching and the live
 * refresh stay owned by page.tsx and RunnerAutoscalerStatus.
 */
export function ShuttlebayWorkspace({
  warnings,
  toolbar,
  children,
}: {
  warnings?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel="Runner fleet"
      className="shuttlebay-workspace"
      warnings={warnings}
      toolbar={toolbar}
    >
      <div className="shuttlebay-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}
