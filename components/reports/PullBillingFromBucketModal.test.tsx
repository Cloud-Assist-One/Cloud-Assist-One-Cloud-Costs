import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PullBillingFromBucketModal from './PullBillingFromBucketModal';

const sources = {
  sources: [
    { id: 'src-1', label: 'Production CUR', container: 'cur-bucket', prefix: 'cur/', cloud_provider: 'aws' },
  ],
};

const pullResult = {
  runs: [
    { key: 'cur/aug/Manifest.json', month: '2026-08-01', status: 'imported', periodKind: 'active', rowCount: 128400 },
    { key: 'cur/jul/Manifest.json', month: '2026-07-01', status: 'imported', periodKind: 'archived', rowCount: 96000 },
    { key: 'cur/old/Manifest.json', month: '2025-01-01', status: 'skipped', reason: 'Older than the 12-month limit.' },
  ],
  imported: 2,
  skipped: 1,
  failed: 0,
};

function renderModal() {
  return render(<PullBillingFromBucketModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);
}

describe('PullBillingFromBucketModal', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  // Everything below the fold depends on this: the pull is destructive-adjacent
  // and must not start on open.
  it('asks for confirmation before pulling anything', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    renderModal();

    expect(await screen.findByRole('button', { name: /^ok$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  // CORRECTION applied here per task instructions: the confirmation copy
  // mentions "archive" more than once (archived period, Archive tab, existing
  // archive replaced), so a single findByText(/archive/i) would throw on an
  // ambiguous match. findAllByText proves the archiving consequence is named
  // at least once; the separate "replaced" assertion proves the same-month
  // replacement consequence is named too. Both consequences must still hold.
  it('names both consequences of archiving, including the replacement', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    renderModal();

    const archiveMentions = await screen.findAllByText(/archive/i);
    expect(archiveMentions.length).toBeGreaterThan(0);
    expect(screen.getByText(/replaced/i)).toBeInTheDocument();
  });

  it('does nothing at all when cancelled', async () => {
    const onClose = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    render(<PullBillingFromBucketModal companyId="company-1" onClose={onClose} onPulled={jest.fn()} />);
    await screen.findByRole('button', { name: /cancel/i });
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('pulls with archiveFirst once confirmed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find((call) => call[1]?.method === 'POST');
      expect(post[0]).toBe('/api/billing-sources/src-1/pull');
      expect(JSON.parse(post[1].body)).toEqual({ companyId: 'company-1', archiveFirst: true });
    });
  });

  it('reports each month and where it landed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByText(/august 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/july 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/active period/i)).toBeInTheDocument();
    expect(screen.getByText(/archived period/i)).toBeInTheDocument();
  });

  // A cap that bites silently would make the report claim a completeness it
  // does not have.
  it('shows what a cap excluded, with its reason', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByText(/12-month limit/i)).toBeInTheDocument();
  });

  it('tells the user to configure a bucket when none exists', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) });

    renderModal();

    expect(await screen.findByText(/settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ok$/i })).not.toBeInTheDocument();
  });

  it('surfaces the route error rather than a generic one', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'The app registration needs the Storage Blob Data Reader role.' }),
      });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Storage Blob Data Reader');
  });
});
