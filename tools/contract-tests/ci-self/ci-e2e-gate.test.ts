import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Workflow {
  jobs?: Record<
    string,
    {
      if?: string;
      name?: string;
      needs?: string[];
      steps?: Array<{ id?: string; if?: string; name?: string; run?: string }>;
    }
  >;
}

describe('CI E2E operational gate', () => {
  it('keeps the selected browser gate CI-owned', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/ci.yml', 'utf8'),
    ) as Workflow;

    expect(workflow.jobs?.e2e?.if).toBe("${{ vars.E2E_ENABLED != 'false' }}");
    expect(workflow.jobs?.e2e?.name).toBe('E2E');
    expect(workflow.jobs?.e2e?.steps).toContainEqual(
      expect.objectContaining({
        id: 'e2e-scope',
        name: 'Determine whether console E2E is affected',
      }),
    );
    expect(workflow.jobs?.e2e?.steps).toContainEqual(
      expect.objectContaining({
        if: "steps.e2e-scope.outputs.run == 'true'",
        name: 'Run console e2e suite [full-suite]',
        run: './tools/e2e-local.sh',
      }),
    );

    expect(workflow.jobs?.verify?.needs).toEqual([
      'verify-full',
      'e2e',
      'e2e-control-flag',
    ]);
    const e2eGate = workflow.jobs?.verify?.steps?.find(
      (step) => step.name === 'Require selected E2E verification',
    );
    expect(e2eGate).toEqual(
      expect.objectContaining({
        if: "github.event_name != 'pull_request' || !github.event.pull_request.draft",
      }),
    );
    expect(e2eGate?.run).toContain('E2E_RESULT');
    expect(e2eGate?.run).toContain('[ "$E2E_RESULT" = \'success\' ]');
    expect(e2eGate?.run).toContain('E2E_CONTROL_FLAG_RESULT');
    expect(e2eGate?.run).toContain('exit 1');
  });
});
