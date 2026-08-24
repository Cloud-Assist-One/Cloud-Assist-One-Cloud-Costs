import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionsPanel from './ConnectionsPanel';

interface TestSummary {
  id: string;
  label: string;
  value: string;
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
});
