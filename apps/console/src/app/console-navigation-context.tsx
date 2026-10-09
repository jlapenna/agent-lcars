'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { NavKey } from './console-navigation';

const NavigationContext = createContext<readonly NavKey[] | undefined>(
  undefined,
);

/** The root server layout supplies only presentation authority, never a
 * session or OAuth token. Shared loading/error/404 views inherit it too. */
export function ConsoleNavigationProvider({
  navigationKeys,
  children,
}: {
  navigationKeys: readonly NavKey[] | undefined;
  children: ReactNode;
}) {
  return (
    <NavigationContext.Provider value={navigationKeys}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useConsoleNavigationKeys() {
  return useContext(NavigationContext);
}
