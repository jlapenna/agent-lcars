import { expect, type Locator } from '@playwright/test';

/** The desktop Bridge header is fixed so route copy cannot shift its workspace. */
export async function expectDesktopBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '80px');
  expect((await header.boundingBox())?.height).toBe(80);
}

/** Mobile routes collapse into one 64px command strip. */
export async function expectMobileBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '64px');
  expect((await header.boundingBox())?.height).toBe(64);
}
