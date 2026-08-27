import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingFileSourcesPanel from './BillingFileSourcesPanel';

const source = {
  id: 'src-1',
  company_id: 'company-1',
  credential_id: 'conn-1',
  cloud_provider: 'aws',
  container: 'cur-bucket',
  prefix: 'cur/',
  label: 'Production CUR',
  enabled: true,
  schedule_enabled: false,
  last_pulled_at: null,
  created_at: '2026-08-27T00:00:00.000Z',
};

const connections = { connections: [{ id: 'conn-1', label: 'Production', region: 'us-east-1' }] };

describe('BillingFileSourcesPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('lists the configured buckets', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [source] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    render(<BillingFileSourcesPanel companyId="company-1" />);

    expect(await screen.findByText('Production CUR')).toBeInTheDocument();
    expect(screen.getByText(/cur-bucket/)).toBeInTheDocument();
  });

  it('says so plainly when no bucket is configured yet', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    render(<BillingFileSourcesPanel companyId="company-1" />);

    expect(await screen.findByText(/no buckets configured/i)).toBeInTheDocument();
  });

  it('posts a new source with the fields entered', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => connections })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ source }) })
      .mockResolvedValue({ ok: true, json: async () => ({ sources: [source] }) });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText(/no buckets configured/i);
    await user.type(screen.getByLabelText(/label/i), 'Production CUR');
    await user.type(screen.getByLabelText(/bucket|container/i), 'cur-bucket');
    await user.type(screen.getByLabelText(/prefix/i), 'cur/');
    await user.click(screen.getByRole('button', { name: /add bucket/i }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find(
        (call) => call[1]?.method === 'POST'
      );
      expect(JSON.parse(post[1].body)).toMatchObject({
        companyId: 'company-1',
        container: 'cur-bucket',
        prefix: 'cur/',
        label: 'Production CUR',
      });
    });
  });

  it('surfaces the route error rather than a generic one', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => connections })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'That connection does not belong to this company.' }) });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText(/no buckets configured/i);
    await user.type(screen.getByLabelText(/label/i), 'X');
    await user.type(screen.getByLabelText(/bucket|container/i), 'b');
    await user.click(screen.getByRole('button', { name: /add bucket/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not belong to this company');
  });

  // Deleting a source is not reversible from the UI, so it asks first.
  it('asks before deleting and does nothing until confirmed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [source] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText('Production CUR');
    await user.click(screen.getByRole('button', { name: /remove/i }));

    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });
});
