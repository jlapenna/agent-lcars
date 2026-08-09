import { expect, type Locator } from '@playwright/test';

/** The desktop command deck is fixed so route copy cannot shift its workspace. */
export async function expectDesktopCommandDeck(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '80px');
  expect((await header.boundingBox())?.height).toBe(80);
}
