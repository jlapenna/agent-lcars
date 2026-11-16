import type { ReactNode } from 'react';

/**
 * The rows a compact panel leaves out, one native disclosure away. A panel
 * keeps its short default, but a list that silently stops at N reads as
 * "that is everything" when it is not, and a bare "Showing N of M" footer
 * still leaves the rest unreachable. The summary states the exact split;
 * opening it renders every remaining row in the same layout.
 *
 * A native `<details>` needs no client JavaScript, so server-rendered
 * panels can use it as-is. Renders nothing while everything already fits.
 */
export function RemainderDisclosure({
  shown,
  total,
  noun,
  children,
  'data-testid': testId,
}: {
  shown: number;
  total: number;
  /** Plural name of one row, e.g. "issues". */
  noun: string;
  /** The rows after the first `shown`. */
  children: ReactNode;
  'data-testid'?: string;
}) {
  if (total <= shown) return null;
  return (
    <details
      className="lcars-disclosure remainder-disclosure"
      data-testid={testId}
    >
      <summary className="lcars-disclosure__summary">
        Showing {shown} of {total} · show {total - shown} more {noun}
      </summary>
      <div className="lcars-disclosure__content">{children}</div>
    </details>
  );
}
