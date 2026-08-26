import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionsPanel from './ConnectionsPanel';

interface TestSummary {
  id: string;
  label: string;
  value: string;
}

interface TestSummaryWithTagKey extends TestSummary {
  tagKey: string;
}

describe('ConnectionsPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows "no connections yet" when the list is empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
  });

  it('lists existing connections with their summary', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
    });

    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText(/value abc/)).toBeInTheDocument();
  });

  it('adds a new connection', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connection: { id: 'c1', label: 'Production', value: 'abc' } }),
      });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/^label$/i), 'Production');
    await user.type(screen.getByLabelText(/^value$/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/test-credentials',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByText('Production')).toBeInTheDocument();
  });

  it('disconnects after confirmation', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText('Production');
    await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
    await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/test-credentials?companyId=company-1&id=c1',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
    expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
  });

  it('surfaces an error if saving fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'label is required.' }) });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/^value$/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/label is required/i);
  });

  it('shows an error instead of staying stuck loading when the initial fetch fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load connections/i);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('surfaces an error and stops saving when the add request rejects', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockRejectedValueOnce(new Error('network error'));

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/^value$/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save the connection/i);
    expect(screen.queryByText(/saving/i)).not.toBeInTheDocument();
  });

  it('surfaces an error and stops disconnecting when the delete request rejects', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
      })
      .mockRejectedValueOnce(new Error('network error'));

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText('Production');
    await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
    await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not disconnect/i);
    expect(screen.queryByText(/disconnecting/i)).not.toBeInTheDocument();
  });

  describe('connection allowance', () => {
    it('leaves the Add connection button enabled when canAdd is true', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          canAdd={true}
          limitMessage={null}
        />
      );

      await screen.findByText(/no connections yet/i);
      expect(screen.getByRole('button', { name: /add connection/i })).toBeEnabled();
    });

    it('disables the Add connection button and shows the limit message when canAdd is false', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          canAdd={false}
          limitMessage="Your Free plan includes 1 cloud connection. Contact us to add more."
        />
      );

      await screen.findByText(/no connections yet/i);
      expect(screen.getByRole('button', { name: /add connection/i })).toBeDisabled();
      expect(screen.getByText(/your free plan includes 1 cloud connection/i)).toBeInTheDocument();
    });

    it('does not render a limit message when none is supplied', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          canAdd={true}
          limitMessage={null}
        />
      );

      await screen.findByText(/no connections yet/i);
      expect(screen.queryByText(/contact us/i)).not.toBeInTheDocument();
    });

    it('still allows editing the tag key and disconnecting when canAdd is false', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });

      const user = userEvent.setup();
      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          canAdd={false}
          limitMessage="At the limit."
        />
      );

      await screen.findByText('Production');
      await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
      await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/settings/test-credentials?companyId=company-1&id=c1',
          expect.objectContaining({ method: 'DELETE' })
        )
      );
      expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
    });

    it('calls onConnectionsChanged after successfully adding a connection', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ connection: { id: 'c1', label: 'Production', value: 'abc' } }),
        });

      const onConnectionsChanged = jest.fn();
      const user = userEvent.setup();
      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          onConnectionsChanged={onConnectionsChanged}
        />
      );

      await screen.findByText(/no connections yet/i);
      await user.click(screen.getByRole('button', { name: /add connection/i }));
      await user.type(screen.getByLabelText(/^label$/i), 'Production');
      await user.type(screen.getByLabelText(/^value$/i), 'abc');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onConnectionsChanged).toHaveBeenCalledTimes(1));
    });

    it('calls onConnectionsChanged after successfully disconnecting', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });

      const onConnectionsChanged = jest.fn();
      const user = userEvent.setup();
      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
          onConnectionsChanged={onConnectionsChanged}
        />
      );

      await screen.findByText('Production');
      await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
      await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

      await waitFor(() => expect(onConnectionsChanged).toHaveBeenCalledTimes(1));
    });
  });

  describe('editing the tag key', () => {
    it('shows the connection\'s current tag key', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connections: [{ id: 'c1', label: 'Production', value: 'abc', tagKey: 'CostCenter' }],
        }),
      });

      render(
        <ConnectionsPanel<TestSummaryWithTagKey>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
        />
      );

      await screen.findByText('Production');
      expect(screen.getByLabelText(/tag key/i)).toHaveValue('CostCenter');
    });

    it('does not show a tag key control when the summary has no tagKey field', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
      });

      render(
        <ConnectionsPanel<TestSummary>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
        />
      );

      await screen.findByText('Production');
      expect(screen.queryByLabelText(/tag key/i)).not.toBeInTheDocument();
    });

    it('PATCHes the new tag key to the configured endpoint and refreshes the row', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            connections: [{ id: 'c1', label: 'Production', value: 'abc', tagKey: 'CostCenter' }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            connection: { id: 'c1', label: 'Production', value: 'abc', tagKey: 'Owner' },
          }),
        });

      const user = userEvent.setup();
      render(
        <ConnectionsPanel<TestSummaryWithTagKey>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
        />
      );

      await screen.findByText('Production');
      const input = screen.getByLabelText(/tag key/i);
      await user.clear(input);
      await user.type(input, 'Owner');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/settings/test-credentials',
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ companyId: 'company-1', id: 'c1', tagKey: 'Owner' }),
          })
        )
      );
      expect(await screen.findByLabelText(/tag key/i)).toHaveValue('Owner');
    });

    it('surfaces an error when saving the tag key fails', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            connections: [{ id: 'c1', label: 'Production', value: 'abc', tagKey: 'CostCenter' }],
          }),
        })
        .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'tagKey must be valid.' }) });

      const user = userEvent.setup();
      render(
        <ConnectionsPanel<TestSummaryWithTagKey>
          companyId="company-1"
          apiPath="/api/settings/test-credentials"
          fields={[{ name: 'value', label: 'Value', type: 'text' }]}
          renderSummary={(c) => `value ${c.value}`}
        />
      );

      await screen.findByText('Production');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/tagkey must be valid/i);
    });
  });
});
