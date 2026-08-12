import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('console deployment workflow', () => {
  it('searches the newest App Hosting builds for the deployed archive', async () => {
    const workflow = await readFile(
      '.github/workflows/deploy-console.yml',
      'utf8',
    );

    expect(workflow).toContain('builds?pageSize=100&orderBy=createTime%20desc');
    expect(workflow).toContain(
      'select(.source.archive.userStorageUri == env.SOURCE_URI)',
    );
  });
});
