import type { ReactNode } from 'react';

import { ConsoleWorkspace } from '../console-workspace';

/**
 * Route-level composition for native work items.
 *
 * Like Shuttlebay, Work never adopted the shared frame: its content — a
 * create form and a six-column table — sat directly on the page ground with
 * no workspace edge and no responsive treatment, so a phone got a table
 * scrolled off the side of the viewport and a desktop got an unframed slab
 * (#1814). The frame supplies the edge and the bands; `work-workspace`'s own
 * rules below it supply the responsive column behavior.
 */
export function WorkWorkspace({
  ariaLabel = 'Work items',
  toolbar,
  children,
}: {
  /** `/work/schedules` reuses this frame for the same route accent and the
   *  same section rhythm, and names its own region. */
  ariaLabel?: string;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace
      ariaLabel={ariaLabel}
      className="work-workspace"
      toolbar={toolbar}
    >
      <div className="work-workspace__content">{children}</div>
    </ConsoleWorkspace>
  );
}
