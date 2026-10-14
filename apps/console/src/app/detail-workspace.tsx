import type { ReactNode } from 'react';

import { ConsoleWorkspace } from './console-workspace';

/**
 * The frame for a drill-down page: a work item, a task, a session. Sub-routes
 * use the same frame as their destinations (docs/console-design-system.md,
 * "One frame"), so a detail page's panels sit inside the workspace edge and
 * warning band rather than on the bare page ground.
 */
export function DetailWorkspace({
  ariaLabel,
  warnings,
  children,
}: {
  ariaLabel: string;
  warnings?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel={ariaLabel}
      className="detail-workspace"
      warnings={warnings}
    >
      <div className="detail-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}
