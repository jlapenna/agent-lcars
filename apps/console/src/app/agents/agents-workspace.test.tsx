import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentsWorkspace } from './agents-workspace';

describe('AgentsWorkspace', () => {
  it('keeps fleet status first and groups active work ahead of secondary work', () => {
    render(
      <AgentsWorkspace
        warnings={<p>Partial data</p>}
        fleet={<p>Fleet status</p>}
        active={<p>Active agents</p>}
        claimedIdle={<p>Claimed idle</p>}
        recentOutcomes={<p>Recent outcomes</p>}
      />,
    );

    const workspace = screen.getByRole('region', {
      name: 'Agent operations',
    });
    expect(workspace.textContent).toBe(
      'Partial dataFleet statusActive agentsClaimed idleRecent outcomes',
    );
    expect(
      workspace.querySelector('.agents-workspace__primary')?.textContent,
    ).toBe('Active agents');
    expect(
      workspace.querySelector('.agents-workspace__secondary')?.textContent,
    ).toBe('Claimed idleRecent outcomes');
  });

  it('does not render warning chrome when there are no warnings', () => {
    const { container } = render(
      <AgentsWorkspace
        fleet={<p>Fleet status</p>}
        active={<p>Active agents</p>}
        claimedIdle={<p>Claimed idle</p>}
        recentOutcomes={<p>Recent outcomes</p>}
      />,
    );

    expect(container.querySelector('.agents-workspace__warnings')).toBeNull();
  });

  it('does not reserve a secondary column when every secondary panel is empty', () => {
    const { container } = render(
      <AgentsWorkspace
        fleet={<p>Fleet status</p>}
        active={<p>Active agents</p>}
        claimedIdle={null}
        recentOutcomes={null}
        hasSecondary={false}
      />,
    );

    expect(container.querySelector('.agents-workspace__secondary')).toBeNull();
  });
});
