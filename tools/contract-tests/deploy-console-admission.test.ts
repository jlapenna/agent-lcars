import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Concurrency {
  group: string;
  'cancel-in-progress': boolean;
}

interface Workflow {
  concurrency?: Concurrency;
  jobs: {
    gate: { if: string };
    deploy: { if: string; concurrency?: Concurrency };
  };
}

const workflow = parse(
  readFileSync('.github/workflows/deploy-console.yml', 'utf8'),
) as Workflow;

// These gate expressions use only property reads, equality and boolean
// operators. Execute the owning expressions; don't copy their predicates.
function groupsFor(
  sourceEvent: string,
  branch: string,
  verifyPassed: boolean,
  eventName = 'workflow_run',
): string[] {
  const context = {
    github: {
      event_name: eventName,
      event: { workflow_run: { event: sourceEvent, head_branch: branch } },
    },
    needs: { gate: { outputs: { verify_passed: 'false' } } },
  };
  const groups = workflow.concurrency ? [workflow.concurrency.group] : [];
  const eligible = runInNewContext(workflow.jobs.gate.if, context, {
    timeout: 100,
  }) as boolean;
  if (eligible && verifyPassed)
    context.needs.gate.outputs.verify_passed = 'true';
  const deploy = runInNewContext(workflow.jobs.deploy.if, context, {
    timeout: 100,
  }) as boolean;
  if (deploy && workflow.jobs.deploy.concurrency)
    groups.push(workflow.jobs.deploy.concurrency.group);
  return groups;
}

describe('production deployment admission', () => {
  it.each([
    ['pull_request', 'main'],
    ['pull_request', 'feature'],
    ['push', 'feature'],
    ['workflow_dispatch', 'main'],
  ])(
    'keeps ineligible %s/%s completion out of the pending production slot',
    (event, branch) => {
      const pendingMain = groupsFor('push', 'main', true);
      expect(pendingMain).toEqual(['deploy-console']);
      expect(groupsFor(event, branch, true)).toEqual([]);
    },
  );

  it('keeps a failed Verify out of production serialization', () => {
    expect(groupsFor('push', 'main', false)).toEqual([]);
  });

  it('serializes admitted main and manual deployment without canceling active work', () => {
    expect(groupsFor('push', 'main', true)).toEqual(['deploy-console']);
    expect(groupsFor('', '', true, 'workflow_dispatch')).toEqual([
      'deploy-console',
    ]);
    expect(workflow.jobs.deploy.concurrency?.['cancel-in-progress']).toBe(
      false,
    );
  });
});
