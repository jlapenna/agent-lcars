import type { ItemRunView, ItemView } from '@agent-lcars/work/derive';

export function isEventWork(item: {
  runs: readonly Pick<ItemRunView, 'sourceRevision'>[];
}) {
  return item.runs.some((run) => run.sourceRevision !== undefined);
}

export function eventOperation(
  run: Pick<ItemRunView, 'pipeline' | 'sourceRevision'>,
): string {
  if (run.sourceRevision?.input['operation'] === 'fleet-triage:v1')
    return 'Issue triage';
  if (run.pipeline === 'inbox-summary') return 'Inbox summary';
  if (run.pipeline === 'handoff-summary') return 'Handoff summary';
  return 'Source update';
}

/** These are recorded source observations, not a fabricated webhook log. */
export function eventSource(
  run: ItemRunView,
  spec: ItemView['spec'],
): { label: string; href?: string } {
  const input = run.sourceRevision?.input;
  if (
    input?.['operation'] === 'fleet-triage:v1' &&
    typeof input['repo'] === 'string' &&
    /^[\w.-]+\/[\w.-]+$/u.test(input['repo']) &&
    Number.isSafeInteger(input['issue']) &&
    Number(input['issue']) > 0
  ) {
    const label = `${input['repo']}#${Number(input['issue'])}`;
    return {
      label,
      href: `https://github.com/${input['repo']}/issues/${Number(input['issue'])}`,
    };
  }
  const key = 'sourceKey' in spec ? spec.sourceKey : undefined;
  if (typeof key !== 'string') return { label: 'Recorded source update' };
  const native = /^work:([0-9A-HJKMNP-TV-Z]{26})(?:\/r\d+)?$/u.exec(key);
  if (native) return { label: key, href: `/work/${native[1]}` };
  const github = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)(?:\/r\d+)?$/u.exec(key);
  if (github)
    return { label: key, href: `/task/${github[1]}/${github[2]}/${github[3]}` };
  return { label: key };
}
