import type { PopoverProps } from '@mantine/core';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

// Shared by the deferred wrapper and the lazily loaded Mantine surface; kept
// apart so neither module imports the other (#2201).
export type TriggerProps = HTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  autoFocus?: boolean;
};

export interface DeferredSurfaceProps {
  kind: 'menu' | 'popover';
  target: (props: TriggerProps) => ReactElement;
  children: ReactNode;
  opened: boolean;
  onChange: (opened: boolean) => void;
  position?: PopoverProps['position'];
  width?: PopoverProps['width'];
  shadow?: PopoverProps['shadow'];
  withArrow?: boolean;
  dropdownClassName?: string;
  focusOnMount?: boolean;
}
