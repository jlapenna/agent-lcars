import { expect, type Locator } from '@playwright/test';

/** The desktop Bridge header is fixed so route copy cannot shift its workspace. */
export async function expectDesktopBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '80px');
  expect((await header.boundingBox())?.height).toBe(80);
}

/** The desktop title rail is one concentric, equal-weight LCARS elbow. */
export async function expectDesktopLcarsElbow(header: Locator) {
  await expectConcentricLcarsElbows(header.locator('.lcars-header'), 16);
}

/** Every supplied surface uses one equal-weight band and concentric radii. */
export async function expectConcentricLcarsElbows(
  surfaces: Locator,
  expectedBandWidth: number,
) {
  const geometries = await surfaces.evaluateAll((elements) =>
    elements.map((element) => {
      const elbow = getComputedStyle(element, '::before');
      const pixels = (value: string) => Number.parseFloat(value);

      return {
        width: pixels(elbow.width),
        top: pixels(elbow.borderTopWidth),
        right: pixels(elbow.borderRightWidth),
        bottom: pixels(elbow.borderBottomWidth),
        left: pixels(elbow.borderLeftWidth),
        outerRadius: pixels(elbow.borderTopLeftRadius),
      };
    }),
  );

  expect(geometries.length).toBeGreaterThan(0);
  for (const geometry of geometries) {
    expect(geometry.top).toBe(expectedBandWidth);
    expect(geometry.left).toBe(expectedBandWidth);
    expect(geometry.right).toBe(0);
    expect(geometry.bottom).toBe(0);
    expect(geometry.outerRadius).toBe(expectedBandWidth * 2);
    expect(geometry.width).toBeGreaterThan(geometry.outerRadius);
  }
}

/** Mobile routes collapse into one 64px command strip. */
export async function expectMobileBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '64px');
  expect((await header.boundingBox())?.height).toBe(64);
}
