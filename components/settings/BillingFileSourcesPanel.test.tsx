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

// What the inspect route returns for a container that reads and parses.
const healthyInspection = {
  prefix: 'cur/',
  objectCount: 2,
  totalBytes: 4096,
  objects: [
    { key: 'cur/20260801-20260831/part_0_0001.csv', etag: 'e1', size: 2048, lastModified: '2026-08-31T00:00:00.000Z' },
    { key: 'cur/20260701-20260731/part_0_0001.csv', etag: 'e2', size: 2048, lastModified: '2026-07-31T00:00:00.000Z' },
  ],
  listingTruncated: false,
  runs: [{ key: 'cur/20260801-20260831/part_0_0001.csv', month: '2026-08-01', partCount: 1, totalBytes: 2048 }],
  sample: {
    key: 'cur/20260801-20260831/part_0_0001.csv',
    byteCount: 2048,
    sheetName: 'Sheet1',
    headers: ['ServiceName', 'ChargePeriodStart', 'BilledCost'],
    columns: [
      { field: 'service_name', label: 'Service', header: 'ServiceName', required: true },
      { field: 'usage_date', label: 'Date', header: 'ChargePeriodStart', required: true },
      { field: 'cost', label: 'Cost', header: 'BilledCost', required: true },
      { field: 'instance_type', label: 'Instance type', header: null, required: false },
    ],
    missingRequired: [],
    tagColumns: [],
    parsedRowCount: 120,
    firstRow: { service: 'Virtual Machines', date: '2026-08-03', cost: 18.4 },
  },
  sampleSkipped: null,
};

/** The same container before its column names were recognised. */
const unreadableColumnsInspection = {
  ...healthyInspection,
  sample: {
    ...healthyInspection.sample,
    headers: ['Widget', 'When', 'HowMuch'],
    columns: [
      { field: 'service_name', label: 'Service', header: null, required: true },
      { field: 'usage_date', label: 'Date', header: null, required: true },
      { field: 'cost', label: 'Cost', header: null, required: true },
    ],
    missingRequired: ['Date', 'Cost'],
    parsedRowCount: 0,
    firstRow: null,
  },
};

/** One configured bucket, and whatever the inspect route is meant to say about it. */
function mockPanel(inspectResponse: { ok: boolean; body: unknown }) {
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (String(url).includes('/inspect')) {
      return { ok: inspectResponse.ok, json: async () => inspectResponse.body };
    }
    if (String(url).includes('billing-file-sources')) {
      return { ok: true, json: async () => ({ sources: [source] }) };
    }
    return { ok: true, json: async () => connections };
  });
}

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

  describe('testing a bucket', () => {
    it('reports a healthy container without importing anything', async () => {
      mockPanel({ ok: true, body: { inspection: healthyInspection } });
      const user = userEvent.setup();
      render(<BillingFileSourcesPanel companyId="company-1" />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));

      expect(await screen.findByText(/parses into 120 row\(s\)/i)).toBeInTheDocument();
      // It must never have gone near the route that writes.
      const called = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
      expect(called.some((url) => url.includes('/inspect'))).toBe(true);
      expect(called.some((url) => url.includes('/pull'))).toBe(false);
    });

    // The whole reason this exists: a column problem must not read as a
    // permissions problem, and the header row has to be visible without
    // expanding anything, because it is the answer.
    it('leads with "Connected" and shows the header row when columns do not resolve', async () => {
      mockPanel({ ok: true, body: { inspection: unreadableColumnsInspection } });
      const user = userEvent.setup();
      render(<BillingFileSourcesPanel companyId="company-1" />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));

      expect(await screen.findByText(/^Connected, and .* no Date or Cost columns\.$/)).toBeInTheDocument();
      expect(screen.getByText('Widget, When, HowMuch')).toBeInTheDocument();
    });

    it('shows a failure beside the bucket it is about', async () => {
      mockPanel({ ok: false, body: { error: 'The app registration needs the Storage Blob Data Reader role.' } });
      const user = userEvent.setup();
      render(<BillingFileSourcesPanel companyId="company-1" />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/storage blob data reader/i);
    });

    it('names the header each field resolved to, and the ones absent', async () => {
      mockPanel({ ok: true, body: { inspection: healthyInspection } });
      const user = userEvent.setup();
      render(<BillingFileSourcesPanel companyId="company-1" />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));
      await screen.findByText(/parses into 120 row\(s\)/i);
      await user.click(screen.getByText(/columns resolved/i));

      expect(screen.getByRole('row', { name: /Date \* ChargePeriodStart/ })).toBeInTheDocument();
      expect(screen.getByRole('row', { name: /Instance type not in this file/ })).toBeInTheDocument();
    });

    it('disables the button while the bucket is being read', async () => {
      let release: (value: unknown) => void = () => {};
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
        if (String(url).includes('/inspect')) {
          await new Promise((resolve) => {
            release = resolve;
          });
          return { ok: true, json: async () => ({ inspection: healthyInspection }) };
        }
        if (String(url).includes('billing-file-sources')) return { ok: true, json: async () => ({ sources: [source] }) };
        return { ok: true, json: async () => connections };
      });

      const user = userEvent.setup();
      render(<BillingFileSourcesPanel companyId="company-1" />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));
      expect(await screen.findByRole('button', { name: /testing…/i })).toBeDisabled();

      release(undefined);
      await waitFor(() => expect(screen.getByRole('button', { name: /test connection/i })).toBeEnabled());
    });
  });
});
