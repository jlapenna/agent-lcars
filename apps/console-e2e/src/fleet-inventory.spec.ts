import { Firestore } from '@google-cloud/firestore';
import { expect, test } from '@playwright/test';

import { usePopulatedFixtures } from './seed';
import {
  E2E_ADMIN_HEADERS,
  useE2eAdminBeforeEach,
} from './util/e2e-test-utils';

function fixtureFirestore() {
  // Write raw telemetry only to the same hermetic database the server reads.
  // Never replace the already-projected HTTP/SSE response in this journey.
  if (
    process.env['E2E_HERMETIC'] !== '1' ||
    process.env['PROJECT_ID'] !== 'demo-no-project' ||
    !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(
      process.env['FIRESTORE_EMULATOR_HOST'] ?? '',
    )
  ) {
    throw new Error(
      'Fleet inventory fixtures require the hermetic loopback emulator',
    );
  }
  return new Firestore({
    projectId: 'demo-no-project',
    databaseId: process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)',
  });
}

useE2eAdminBeforeEach();
usePopulatedFixtures();

test('configured ARC inventory missing and restored reaches server and rendered totals', async ({
  page,
}, testInfo) => {
  const firestore = fixtureFirestore();
  const collection = firestore.collection('runner-status');
  const survivor = collection.doc('e2e-fixture-arc-lane');
  const restored = collection.doc('e2e-fixture-arc-lane-restored');
  const expectedLanes = 'e2e-fixture-runners,e2e-fixture-runners-restored';
  try {
    const original = (await survivor.get()).data();
    expect(original).toBeDefined();
    expect((await restored.get()).exists).toBe(false);
    await survivor.update({
      expectedLanes,
      updatedAt: new Date().toISOString(),
    });

    const missingResponse = await page.request.get('/api/runner-status', {
      headers: E2E_ADMIN_HEADERS,
    });
    expect(missingResponse.status()).toBe(200);
    const missing = await missingResponse.json();
    expect(missing.lanes).toHaveLength(1);
    expect(missing.lanes[0].expectedLanes).toBe(expectedLanes);
    expect(missing.lanesIncomplete).toBe(true);
    expect(missing.warnings).toContain(
      'Configured ARC lane status is missing.',
    );
    await testInfo.attach('missing-server-projection', {
      body: JSON.stringify(missing),
      contentType: 'application/json',
    });
    for (const path of ['/', '/agents']) {
      await page.goto(path);
      await expect(page.getByTestId('fleet-chip')).toContainText(
        'GitHub runner status unavailable',
      );
      await expect(page.getByTestId('metric-runner-occupancy')).toHaveCount(0);
    }

    // Restore the never-published lane without changing either inventory.
    // This lane is genuinely idle in the fixture, not an unavailable zero.
    const zeroCounts = {
      assignedJobs: 0,
      runningJobs: 0,
      pendingJobs: 0,
      idleRunners: 0,
      registeredRunners: 0,
      desiredRunners: 0,
    };
    await restored.set({
      ...original,
      ...zeroCounts,
      lane: 'e2e-fixture-runners-restored',
      expectedLanes,
      updatedAt: new Date().toISOString(),
    });
    const restoredResponse = await page.request.get('/api/runner-status', {
      headers: E2E_ADMIN_HEADERS,
    });
    expect(restoredResponse.status()).toBe(200);
    const complete = await restoredResponse.json();
    expect(complete.lanes).toHaveLength(2);
    expect(
      complete.lanes.map(
        (lane: { expectedLanes: string }) => lane.expectedLanes,
      ),
    ).toEqual([expectedLanes, expectedLanes]);
    expect(complete.lanesIncomplete).toBeUndefined();
    expect(complete.warnings).not.toContain(
      'Configured ARC lane status is missing.',
    );
    await testInfo.attach('restored-server-projection', {
      body: JSON.stringify(complete),
      contentType: 'application/json',
    });
    for (const path of ['/', '/agents']) {
      await page.goto(path);
      await expect(page.getByTestId('fleet-chip')).toContainText(
        '2 GitHub runners online (1 running)',
      );
    }

    await survivor.update({
      ...zeroCounts,
      updatedAt: new Date().toISOString(),
    });
    const zeroResponse = await page.request.get('/api/runner-status', {
      headers: E2E_ADMIN_HEADERS,
    });
    expect(zeroResponse.status()).toBe(200);
    const zero = await zeroResponse.json();
    expect(zero.lanesIncomplete).toBeUndefined();
    expect(zero.lanes).toHaveLength(2);
    expect(
      zero.lanes.map(
        (lane: { registeredRunners: number }) => lane.registeredRunners,
      ),
    ).toEqual([0, 0]);
    await testInfo.attach('zero-server-projection', {
      body: JSON.stringify(zero),
      contentType: 'application/json',
    });
    for (const path of ['/', '/agents']) {
      await page.goto(path);
      await expect(page.getByTestId('fleet-chip')).toContainText(
        '0 GitHub runners online (0 running)',
      );
    }
  } finally {
    try {
      await restored.delete();
    } finally {
      await firestore.terminate();
    }
  }
});
