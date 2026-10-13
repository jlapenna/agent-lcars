import { expect, type Locator } from '@playwright/test';

/** The frame grows to contain its title/actions and destination rows. */
export async function expectDesktopBridgeHeader(header: Locator) {
  await expect(header).toBeVisible();
  const boxes = await header.evaluate((element) => {
    const header = element.getBoundingClientRect();
    const rail = element.querySelector('.lcars-nav');
    if (!rail) throw new Error('LCARS destination rail is missing');
    const nav = rail.getBoundingClientRect();
    return { bottom: header.bottom, navBottom: nav.bottom };
  });
  expect(boxes.bottom - boxes.navBottom).toBeGreaterThanOrEqual(12);
}

/**
 * The desktop frame (design/fleet-console.html): a broad rail down the page's
 * leading edge whose head turns through a concentric knee into the header's
 * arm, enclosing the title and the square destination modules.
 */
export async function expectDesktopLcarsElbow(header: Locator) {
  const layout = await header.evaluate((element) => {
    const shell = element.closest('.console-page-shell');
    const railHead = shell?.querySelector(':scope > .lcars-rail-head');
    const arm = element.querySelector('.lcars-header-arm');
    const title = element.querySelector('.lcars-header-title');
    const nav = element.querySelector('.lcars-nav');
    if (!shell || !railHead) throw new Error('LCARS elbow rail is missing');
    if (!arm) throw new Error('LCARS header arm is missing');
    if (!title) throw new Error('LCARS header title is missing');
    if (!nav) throw new Error('LCARS destination rail is missing');

    const headStyle = getComputedStyle(railHead);
    const knee = getComputedStyle(railHead, '::after');
    const headBounds = railHead.getBoundingClientRect();
    const armBounds = arm.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const navBounds = nav.getBoundingClientRect();
    const headerBounds = element.getBoundingClientRect();
    const modules = Array.from(nav.querySelectorAll('.lcars-nav-pill')).map(
      (module) => {
        const bounds = module.getBoundingClientRect();
        const style = getComputedStyle(module);
        return {
          top: bounds.top,
          background: style.backgroundColor,
          radius: Number.parseFloat(style.borderTopLeftRadius),
        };
      },
    );

    return {
      frame: shell.getAttribute('data-frame'),
      headBackground: headStyle.backgroundColor,
      headRadius: Number.parseFloat(headStyle.borderTopLeftRadius),
      headTop: headBounds.top,
      headRight: headBounds.right,
      headBottom: headBounds.bottom,
      headerTop: headerBounds.top,
      headerBottom: headerBounds.bottom,
      kneeBackground: knee.backgroundColor,
      kneeMask: knee.maskImage || knee.webkitMaskImage,
      kneeWidth: Number.parseFloat(knee.width),
      armTop: armBounds.top,
      armLeft: armBounds.left,
      armBottom: armBounds.bottom,
      armHeight: armBounds.height,
      armToken: Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--lcars-elbow-arm'),
      ),
      titleTop: titleBounds.top,
      titleLeft: titleBounds.left,
      navTop: navBounds.top,
      navLeft: navBounds.left,
      modules,
    };
  });

  expect(layout.frame).toBe('rail');
  // The rail head and the header share one grid row, flush at the top.
  expect(Math.abs(layout.headTop - layout.headerTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.headBottom - layout.headerBottom)).toBeLessThanOrEqual(
    1,
  );
  expect(layout.headBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(layout.headRadius).toBeGreaterThan(layout.armHeight * 2);
  // The knee spans the column gap in the head's colour, cut by a quarter
  // circle, and the arm continues from it.
  expect(layout.kneeBackground).toBe(layout.headBackground);
  expect(layout.kneeMask).toContain('radial-gradient');
  expect(
    Math.abs(layout.headRight + layout.kneeWidth - layout.armLeft),
  ).toBeLessThanOrEqual(1);
  expect(layout.armHeight).toBe(layout.armToken);
  expect(Math.abs(layout.armTop - layout.headTop)).toBeLessThanOrEqual(1);
  // Title and navigation sit inside the elbow: below the arm, beside the rail.
  expect(layout.titleTop).toBeGreaterThan(layout.armBottom);
  expect(layout.titleLeft).toBeGreaterThan(layout.headRight);
  expect(layout.navTop).toBeGreaterThan(layout.titleTop);
  expect(layout.navLeft).toBeGreaterThan(layout.headRight);
  expect(layout.modules).toHaveLength(7);
  for (const module of layout.modules) {
    expect(module.top).toBeGreaterThan(layout.armBottom);
    expect(module.background).not.toBe('rgba(0, 0, 0, 0)');
    // Square modules: the elbow is the page's only curve.
    expect(module.radius).toBe(0);
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
