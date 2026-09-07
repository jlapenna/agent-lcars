import { expect, type Locator } from '@playwright/test';

/** The desktop Bridge header is fixed so route copy cannot shift its workspace. */
export async function expectDesktopBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '80px');
  expect((await header.boundingBox())?.height).toBe(80);
}

/** The desktop title and destination rail form one continuous LCARS assembly. */
export async function expectDesktopLcarsElbow(header: Locator) {
  const layout = await header.evaluate((element) => {
    const elbow = getComputedStyle(element, '::before');
    const headerStyle = getComputedStyle(element);
    const title = element.querySelector('.lcars-header-title');
    const nav = element.querySelector('.lcars-nav');
    const commandRow = element.querySelector('.lcars-command-row');
    if (!title) throw new Error('LCARS header title is missing');
    if (!nav) throw new Error('LCARS destination rail is missing');
    if (!commandRow) throw new Error('LCARS command row is missing');

    const headerBounds = element.getBoundingClientRect();
    const titleBayBounds = title
      .closest('.lcars-header')
      ?.getBoundingClientRect();
    const commandRowBounds = commandRow.getBoundingClientRect();
    if (!titleBayBounds) throw new Error('LCARS title bay is missing');
    const titleBounds = title.getBoundingClientRect();
    const navBounds = nav.getBoundingClientRect();
    const armWidth = Number.parseFloat(
      headerStyle.getPropertyValue('--lcars-elbow-arm'),
    );
    const railWidth = Number.parseFloat(
      headerStyle.getPropertyValue('--lcars-elbow-rail'),
    );
    const innerRadius = Number.parseFloat(
      headerStyle.getPropertyValue('--lcars-elbow-inner-radius'),
    );
    const outerRadius = Number.parseFloat(
      headerStyle.getPropertyValue('--lcars-elbow-outer-radius'),
    );
    const modules = Array.from(nav.querySelectorAll('.lcars-nav-pill')).map(
      (module) => {
        const bounds = module.getBoundingClientRect();
        const style = getComputedStyle(module);
        return {
          top: bounds.top,
          width: bounds.width,
          background: style.backgroundColor,
          topLeftRadius: Number.parseFloat(style.borderTopLeftRadius),
          bottomLeftRadius: Number.parseFloat(style.borderBottomLeftRadius),
        };
      },
    );

    return {
      armWidth,
      railWidth,
      innerRadius,
      outerRadius,
      elbowBackground: elbow.backgroundImage,
      elbowRight: headerBounds.left + Number.parseFloat(elbow.width),
      titleTop: titleBounds.top,
      titleLeft: titleBounds.left,
      titleRight: titleBounds.right,
      titleBayRight: titleBayBounds.right,
      titleBayWidth: titleBayBounds.width,
      navTop: navBounds.top,
      navLeft: navBounds.left,
      navRight: navBounds.right,
      headerRight: headerBounds.right,
      headerTop: headerBounds.top,
      commandRowLeft: commandRowBounds.left,
      commandRowRight: commandRowBounds.right,
      innerTop: headerBounds.top + armWidth,
      innerLeft: headerBounds.left + railWidth,
      commandRowBackground: getComputedStyle(commandRow).backgroundImage,
      modules,
    };
  });

  expect(layout.armWidth).toBe(16);
  expect(layout.railWidth).toBe(48);
  expect(layout.railWidth).toBeGreaterThan(layout.armWidth);
  expect(layout.innerRadius).toBe(layout.armWidth);
  expect(layout.outerRadius).toBe(layout.armWidth * 2);
  expect(layout.elbowBackground).toContain('radial-gradient');
  expect(layout.elbowBackground.match(/linear-gradient/g)).toHaveLength(2);
  expect(layout.titleTop).toBeGreaterThanOrEqual(layout.innerTop);
  expect(layout.titleLeft).toBeGreaterThan(layout.innerLeft);
  expect(layout.elbowRight).toBeGreaterThanOrEqual(layout.titleRight);
  expect(layout.titleBayRight).toBe(layout.commandRowLeft);
  expect(layout.titleBayWidth).toBeGreaterThan(272);
  expect(layout.commandRowRight).toBe(layout.headerRight);
  expect(layout.navTop).toBe(layout.headerTop);
  expect(layout.navLeft).toBeGreaterThan(layout.innerLeft);
  expect(layout.elbowRight).toBeGreaterThanOrEqual(layout.navRight);
  expect(layout.elbowRight).toBe(layout.headerRight);
  expect(layout.commandRowBackground).toContain('linear-gradient');
  expect(layout.commandRowBackground).not.toContain('none');
  expect(layout.modules).toHaveLength(7);
  expect(
    new Set(layout.modules.map((module) => module.width)).size,
  ).toBeGreaterThan(2);
  for (const module of layout.modules) {
    expect(module.top).toBeGreaterThan(layout.innerTop);
    expect(module.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(module.topLeftRadius).toBeGreaterThan(0);
    expect(module.bottomLeftRadius).toBeGreaterThan(0);
    expect(module.topLeftRadius).toBe(module.bottomLeftRadius);
  }
}

/**
 * Every supplied panel carries the route accent as a flat spine down its
 * leading edge - square ends, one shared width, no curve.
 *
 * This replaced `expectConcentricLcarsElbows`, which asserted the opposite:
 * that each panel drew its own half-scale copy of the header's elbow. The
 * elbow is the page frame's device and belongs to the frame alone; repeating
 * it per panel made a route read as a frame inside a frame inside a frame
 * (#1827). What is being pinned here is that panels agree with each other,
 * which is why the width is read from the shared token rather than passed in.
 */
export async function expectLcarsPanelSpines(panels: Locator) {
  const geometries = await panels.evaluateAll((elements) =>
    elements.map((element) => {
      const spine = getComputedStyle(element, '::before');
      const pixels = (value: string) => Number.parseFloat(value);

      return {
        width: pixels(spine.width),
        topLeftRadius: pixels(spine.borderTopLeftRadius),
        bottomLeftRadius: pixels(spine.borderBottomLeftRadius),
        background: spine.backgroundColor,
        expected: Number.parseFloat(
          getComputedStyle(element).getPropertyValue('--lcars-spine-width'),
        ),
      };
    }),
  );

  expect(geometries.length).toBeGreaterThan(0);
  for (const geometry of geometries) {
    expect(geometry.expected).toBeGreaterThan(0);
    expect(geometry.width).toBe(geometry.expected);
    // Square: the curve belongs to the header elbow, not to a panel.
    expect(geometry.topLeftRadius).toBe(0);
    expect(geometry.bottomLeftRadius).toBe(0);
    expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
  }

  // One accent per page: every panel's spine is the same colour.
  expect(new Set(geometries.map((geometry) => geometry.background)).size).toBe(
    1,
  );
}

/** Mobile routes reuse the title-inside-the-elbow desktop composition. */
export async function expectMobileBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  await expect(header).toHaveCSS('height', '74px');
  expect((await header.boundingBox())?.height).toBe(74);

  const elbow = await header.evaluate((element) => {
    const headerStyle = getComputedStyle(element);
    const commandRow = element.querySelector('.lcars-command-row');
    const title = element.querySelector('.lcars-header-title');
    const navigation = element.querySelector('.lcars-nav');
    const activeDestination = element.querySelector(
      '.lcars-nav-pill[data-active]',
    );
    if (!commandRow) throw new Error('Mobile LCARS command row is missing');
    if (!title) throw new Error('Mobile LCARS title is missing');
    if (!navigation) throw new Error('Mobile LCARS navigation is missing');
    if (!activeDestination) {
      throw new Error('Mobile LCARS active destination is missing');
    }

    const frameElbow = getComputedStyle(element, '::before');
    const titleBounds = title.getBoundingClientRect();
    const commandBounds = commandRow.getBoundingClientRect();
    const pixels = (property: string) =>
      Number.parseFloat(headerStyle.getPropertyValue(property));

    return {
      hasUtilities: element.hasAttribute('data-has-utilities'),
      armWidth: pixels('--lcars-elbow-arm'),
      railWidth: pixels('--lcars-elbow-rail'),
      innerRadius: pixels('--lcars-elbow-inner-radius'),
      outerRadius: pixels('--lcars-elbow-outer-radius'),
      background: frameElbow.backgroundImage,
      titleDisplay: getComputedStyle(title).display,
      titleWidth: titleBounds.width,
      titleRight: titleBounds.right,
      commandLeft: commandBounds.left,
      navigationDisplay: getComputedStyle(navigation).display,
      activeWidth: activeDestination.getBoundingClientRect().width,
    };
  });

  expect(elbow.armWidth).toBe(10);
  expect(elbow.railWidth).toBe(44);
  expect(elbow.innerRadius).toBeGreaterThan(elbow.armWidth);
  expect(elbow.outerRadius).toBeGreaterThan(elbow.innerRadius);
  expect(elbow.background).toContain('radial-gradient');
  expect(elbow.background.match(/linear-gradient/g)).toHaveLength(2);
  expect(elbow.titleDisplay).not.toBe('none');
  expect(elbow.titleWidth).toBeGreaterThan(0);
  expect(elbow.titleRight).toBeLessThanOrEqual(elbow.commandLeft);
  if (elbow.hasUtilities) {
    expect(elbow.navigationDisplay).toBe('none');
    expect(elbow.activeWidth).toBe(0);
  } else {
    expect(elbow.navigationDisplay).toBe('flex');
    expect(elbow.activeWidth).toBeGreaterThanOrEqual(44);
  }
}
