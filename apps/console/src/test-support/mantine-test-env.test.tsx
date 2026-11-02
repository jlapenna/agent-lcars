import { MantineProvider, Modal } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// vitest-setup.ts defaults every MantineProvider to env="test", so overlays
// unmount the moment they close instead of after an exit transition a loaded
// runner can stretch past a waitFor deadline.
describe('Mantine test environment', () => {
  it('removes a closed modal synchronously, without an exit transition', () => {
    const modal = (opened: boolean) => (
      <MantineProvider>
        <Modal opened={opened} onClose={() => undefined} title="Edit">
          body
        </Modal>
      </MantineProvider>
    );
    const { rerender } = render(modal(true));
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(modal(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
