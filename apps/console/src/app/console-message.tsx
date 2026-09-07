import type { ReactNode } from 'react';

import { ConsoleWorkspace } from './console-workspace';

/**
 * The shared frame for the console's message states - loading, not found, and
 * the error boundary.
 *
 * These are the last three views that rendered their content as bare text on
 * the page ground while every route beside them sat in a frame, so a 404 read
 * as an unstyled fragment under an otherwise complete LCARS header (#1833).
 * They are not workspaces, but they are the same rule: content lives inside
 * the frame. The panel spine ties the message to the route accent, which for
 * all three is the Bridge's, since a missing or broken resource belongs to no
 * section.
 */
export function ConsoleMessage({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <ConsoleWorkspace ariaLabel={ariaLabel} className="console-message">
      <div className="console-message__body lcars-panel">{children}</div>
    </ConsoleWorkspace>
  );
}
