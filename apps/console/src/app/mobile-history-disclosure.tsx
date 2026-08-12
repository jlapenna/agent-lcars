'use client';

import { Stack, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { type ComponentProps, type ReactNode, useState } from 'react';

/**
 * Keeps long archival lists scannable on phones without changing their
 * desktop fidelity. Callers mark older children with
 * `data-mobile-history-extra`; CSS hides only those descendants at the
 * mobile breakpoint until this disclosure is expanded. Server-rendered
 * children stay on the server side of the RSC boundary.
 */
export function MobileHistoryDisclosure({
  children,
  hiddenCount,
  itemLabel,
  className,
  gap,
  testId,
}: {
  children: ReactNode;
  hiddenCount: number;
  itemLabel: string;
  className?: string;
  gap?: ComponentProps<typeof Stack>['gap'];
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const countedLabel = `${itemLabel}${hiddenCount === 1 ? '' : 's'}`;

  return (
    <Stack
      gap={gap}
      className={`mobile-history-disclosure${className ? ` ${className}` : ''}`}
      data-expanded={expanded || undefined}
      data-testid={testId}
    >
      {children}
      {hiddenCount > 0 && (
        <UnstyledButton
          type="button"
          className="mobile-history-disclosure__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <IconChevronUp size={18} aria-hidden="true" />
          ) : (
            <IconChevronDown size={18} aria-hidden="true" />
          )}
          {expanded
            ? `Show fewer ${itemLabel}s`
            : `Show ${hiddenCount} older ${countedLabel}`}
        </UnstyledButton>
      )}
    </Stack>
  );
}
