import type { ReactNode } from 'react';

import { DataWarnings } from './console-header';

/**
 * Shared LCARS frame for operational route workspaces.
 *
 * Every primary destination puts its content in one of these, so the ground,
 * edge, warning band and toolbar band are identical everywhere and a route
 * only decides how information is arranged inside. Each slot carries both the
 * shared class (which owns the appearance) and the route's own (which owns
 * only route-specific arrangement) - before #1828 the shared half did not
 * exist and three routes each restated the same warning-band and toolbar
 * rules, which is how they drifted apart.
 */
export function ConsoleWorkspace({
  ariaLabel,
  className,
  warnings,
  toolbar,
  children,
}: {
  ariaLabel: string;
  className: string;
  /** The route's `DataWarnings`. Omitted, the band still shows that nothing
   * was reported; `false` drops the band (message states). */
  warnings?: ReactNode | false;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`console-workspace ${className}`}
      aria-label={ariaLabel}
    >
      {warnings === false ? null : (
        <div className={`console-workspace__warnings ${className}__warnings`}>
          {warnings ?? <DataWarnings warnings={[]} sourcesChecked={false} />}
        </div>
      )}
      {toolbar ? (
        <div className={`console-workspace__toolbar ${className}__toolbar`}>
          {toolbar}
        </div>
      ) : null}
      {children}
    </section>
  );
}
