import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CostsWorkspace } from './costs-workspace';

describe('CostsWorkspace', () => {
  it('keeps warnings ahead of the ledger content', () => {
    render(
      <CostsWorkspace warnings={<p>Partial data</p>}>
        <p>Ledger rows</p>
      </CostsWorkspace>,
    );

    const workspace = screen.getByRole('region', { name: 'Cost ledger' });
    expect(workspace.textContent).toBe('Partial dataLedger rows');
    expect(
      workspace.querySelector('.costs-workspace__content')?.textContent,
    ).toBe('Ledger rows');
  });

  it('does not render warning chrome when there are no warnings', () => {
    const { container } = render(
      <CostsWorkspace>
        <p>Ledger rows</p>
      </CostsWorkspace>,
    );

    expect(container.querySelector('.costs-workspace__warnings')).toBeNull();
  });
});
