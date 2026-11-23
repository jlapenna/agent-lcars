import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { type TaskId, taskKey } from './model';
import { Orchestrator } from './orchestrator';

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];

if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  emulatorHost === undefined
) {
  throw new Error(
    'REQUIRE_FIRESTORE_EMULATOR=1 but FIRESTORE_EMULATOR_HOST is unset',
  );
}

/** Crockford base32, 26 characters; the pattern excludes I, L, O and U. */
function workId(seedValue: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVZX';
  let text = '';
  let value = seedValue;
  for (let index = 0; index < 26; index += 1) {
    text += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length) + index + 7;
  }
  return text;
}

const github = (repo: string, issue: number): TaskId => ({ repo, issue });
const native = (id: string): TaskId => ({ workId: id });

/** `request` mints the task document and its first run, so the fixtures are
 * the shapes production writes rather than hand-built documents. */
async function seed(store: MemoryStore | FirestoreStore, ids: TaskId[]) {
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-01-01T00:00:00.000Z',
  });
  for (const [index, taskId] of ids.entries()) {
    const result = await orchestrator.request({
      taskId,
      requestId: `batched-${index}`,
      pipeline: 'claude',
      priority: 'normal',
      work: { spec: { title: 'batched run read' } },
    });
    if (isRefusal(result)) throw new Error(`fixture refused: ${index}`);
    decidedRun(result);
  }
}

/** Both implementations share the contract: the memory store is the reference
 * the orchestrator's own tests treat as correct, the Firestore one is what the
 * console's Bridge, Work and Agents pages actually hit. */
function describeBatchedReads(
  name: string,
  makeStore: () => MemoryStore | FirestoreStore,
) {
  describe(`${name}: batched run and task reads`, () => {
    it('maps every requested task, empty for one with no runs', async () => {
      const store = makeStore();
      const ids = [
        github('octo/alpha', 1),
        github('octo/alpha', 2),
        github('octo/beta', 7),
        native(workId(3)),
      ];
      await seed(store, ids);
      const missing = github('octo/none', 99);

      const runs = await store.listRunsForTasks([...ids, missing]);

      expect(runs.size).toBe(ids.length + 1);
      for (const id of ids) expect(runs.get(taskKey(id))).toHaveLength(1);
      expect(runs.get(taskKey(missing))).toEqual([]);
    });

    it('agrees with listRuns across the chunk boundary', async () => {
      const store = makeStore();
      const ids: TaskId[] = [];
      for (let issue = 1; issue <= 35; issue += 1)
        ids.push(github('octo/wide', issue));
      ids.push(native(workId(11)));
      await seed(store, ids);

      const batched = await store.listRunsForTasks(ids);
      for (const id of ids)
        expect(batched.get(taskKey(id))).toEqual(await store.listRuns(id));
    });

    it('never files another task under a requested key', async () => {
      const store = makeStore();
      const ids = [github('octo/alpha', 1), github('octo/beta', 2)];
      await seed(store, ids);

      const runs = await store.listRunsForTasks([ids[0]!]);
      expect([...runs.keys()]).toEqual([taskKey(ids[0]!)]);
      expect(runs.get(taskKey(ids[0]!))).toHaveLength(1);
    });

    it('reads each task document and omits a missing one', async () => {
      const store = makeStore();
      const ids = [github('octo/alpha', 1), native(workId(5))];
      await seed(store, ids);

      const found = await store.readTasks([...ids, github('octo/none', 99)]);

      expect([...found.keys()].sort()).toEqual(ids.map(taskKey).sort());
      for (const id of ids)
        expect(found.get(taskKey(id))?.task).toEqual(
          (await store.readTask(id))?.task,
        );
    });

    it('reads more tasks than one batched document read holds', async () => {
      const store = makeStore();
      const ids: TaskId[] = [];
      for (let issue = 1; issue <= 120; issue += 1)
        ids.push(github('octo/wide', issue));
      await seed(store, ids);

      expect((await store.readTasks(ids)).size).toBe(120);
    });

    it('reads anchor projections in request order across batches', async () => {
      const store = makeStore();
      const anchors = Array.from({ length: 130 }, (_, index) => ({
        repo: 'octo/anchors',
        issue: index + 1,
      }));
      // Every third anchor has a stored projection; the rest are unknown.
      for (const anchor of anchors.filter((_, index) => index % 3 === 0)) {
        const generation =
          await store.beginGithubAnchorProjectionRefresh(anchor);
        await store.applyGithubAnchorProjectionRefresh({
          anchor,
          generation,
          projection: {
            anchor,
            kind: 'pr',
            state: 'closed',
            title: `PR ${anchor.issue}`,
            body: '',
            url: `https://github.com/octo/anchors/pull/${anchor.issue}`,
            labels: [],
            assigneeLogins: [],
            sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
            observedAt: '2026-08-30T12:00:01.000Z',
          },
        });
      }

      const read = await store.readGithubAnchorProjections(anchors);

      expect(read.map((projection) => projection?.title)).toEqual(
        anchors.map((anchor, index) =>
          index % 3 === 0 ? `PR ${anchor.issue}` : undefined,
        ),
      );
    });
  });
}

describeBatchedReads('MemoryStore', () => new MemoryStore());

// The Firestore store needs the emulator for any read; without it every case
// here would hang rather than prove anything.
describe.skipIf(emulatorHost === undefined)('FirestoreStore (emulator)', () => {
  describeBatchedReads('FirestoreStore', () => {
    if (emulatorHost === undefined) throw new Error('emulator required');
    return new FirestoreStore({
      projectId: 'demo-orchestrator',
      databaseId: '(default)',
      collectionPrefix: `batched-${crypto.randomUUID()}-`,
      emulatorHost,
    });
  });
});
