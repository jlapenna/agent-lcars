import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('production console session smoke workflow', () => {
  it('uses the real codex-agent identity and enforces an expiry safety window', async () => {
    const workflow = await readFile(
      '.github/workflows/verify-console-session.yml',
      'utf8',
    );

    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('vars.GCP_WIF_PROVIDER');
    expect(workflow).toContain('vars.GCP_CODEX_AGENT_SA');
    expect(workflow).toContain('--storage secret');
    expect(workflow).toContain('--path /agents');
    expect(workflow).toContain('--minimum-valid-days 7');
    expect(workflow).not.toContain('AUTH_SECRET');
  });
});
