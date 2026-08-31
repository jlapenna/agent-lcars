import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Workflow {
  jobs?: Record<
    string,
    {
      if?: string;
      name?: string;
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
  });

  it('keeps local E2E optional in the canonical agent guidance', async () => {
    const [protocol, contributorSkill, verificationGuide, reliabilityPolicy] =
      await Promise.all([
        readFile(
          '.agents/skills/agent-protocol/reference/agent-protocol.md',
          'utf8',
        ),
        readFile('.agents/skills/agent-lcars-dev/SKILL.md', 'utf8'),
        readFile('.agents/skills/agent-lcars-dev/references/verify.md', 'utf8'),
        readFile('docs/e2e-reliability.md', 'utf8'),
      ]);

    expect(protocol).toMatch(/local E2E is optional/iu);
    expect(protocol).toMatch(/CI owns required E2E/iu);
    expect(contributorSkill).toMatch(/local E2E is optional/iu);
    expect(contributorSkill).toMatch(/CI['’]s\s+E2E job owns/iu);
    expect(verificationGuide).toMatch(/local E2E\s+is\s+optional/iu);
    expect(verificationGuide).toMatch(/CI owns the\s+required E2E gate/iu);
    expect(reliabilityPolicy).toMatch(/local E2E\s+is\s+optional/iu);
    expect(reliabilityPolicy).toMatch(/CI owns the\s+required E2E gate/iu);

    expect(verificationGuide).not.toMatch(
      /run `console-e2e:e2e-local`\s*\([^)]*\) before pushing/iu,
    );
    expect(reliabilityPolicy).not.toMatch(
      /complete local E2E target before delivery/iu,
    );
  });
});
