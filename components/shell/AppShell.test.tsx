import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppShell from './AppShell';

jest.mock('./../files/UploadedFilesList', () => ({
  __esModule: true,
  default: () => <div>files-tab-content</div>,
}));
jest.mock('./../reports/CostReportTab', () => ({
  __esModule: true,
  default: ({ cloudProvider }: { cloudProvider: string }) => <div>report-tab-content for {cloudProvider}</div>,
}));
jest.mock('./../reports/CompareTab', () => ({
  __esModule: true,
  default: () => <div>compare-tab-content</div>,
}));
jest.mock('./../reports/LineItemsTab', () => ({
  __esModule: true,
  default: () => <div>line-items-tab-content</div>,
}));
jest.mock('./../notes/NotesFeed', () => ({
  __esModule: true,
  default: ({ isStaff }: { isStaff: boolean }) => <div>notes-feed-content isStaff={String(isStaff)}</div>,
}));
jest.mock('./../admin/AdminCompanies', () => ({
  __esModule: true,
  default: () => <div>admin-companies-content</div>,
}));
jest.mock('./../admin/AdminUserEmails', () => ({
  __esModule: true,
  default: () => <div>admin-user-emails-content</div>,
}));
jest.mock('./../admin/AdminUsers', () => ({
  __esModule: true,
  default: () => <div>admin-users-content</div>,
}));
jest.mock('./ArchiveTab', () => ({
  __esModule: true,
  default: ({ onSelectPeriod }: { onSelectPeriod: (periodId: string) => void }) => (
    <div>
      archive-tab-content
      <button onClick={() => onSelectPeriod('archived-period-1')}>select archived period</button>
    </div>
  ),
}));
jest.mock('./../settings/SettingsTab', () => ({
  __esModule: true,
  default: () => <div>settings-tab-content</div>,
}));
jest.mock('./../support/SupportRequestsTab', () => ({
  __esModule: true,
  default: () => <div>support-requests-content</div>,
}));
jest.mock('./../reports/AwsResourcesTab', () => ({
  __esModule: true,
  default: () => <div>aws-resources-tab-content</div>,
}));
jest.mock('./../reports/AwsIamUsersTab', () => ({
  __esModule: true,
  default: () => <div>aws-iam-users-tab-content</div>,
}));
jest.mock('./../reports/AzureResourcesTab', () => ({
  __esModule: true,
  default: () => <div>azure-resources-tab-content</div>,
}));
jest.mock('./../reports/AzureUsersTab', () => ({
  __esModule: true,
  default: () => <div>azure-users-tab-content</div>,
}));
jest.mock('./../reports/FindingsTab', () => ({
  __esModule: true,
  default: ({ provider, kind }: { provider: string; kind: string }) => (
    <div>findings-tab-content for {provider} {kind}</div>
  ),
}));

const signOut = jest.fn();
const listCompanies = jest.fn();
const listActivePeriod = jest.fn();
const lookupCompanyName = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signOut: (...args: unknown[]) => signOut(...args) },
    from: (table: string) => {
      if (table === 'billing_periods') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ single: (...args: unknown[]) => listActivePeriod(...args) }) }),
          }),
        };
      }
      // The companies table is read two ways: ordered list for the staff
      // switcher, and a single-row name lookup for the top-bar greeting.
      return {
        select: () => ({
          order: (...args: unknown[]) => listCompanies(...args),
          eq: () => ({ maybeSingle: (...args: unknown[]) => lookupCompanyName(...args) }),
        }),
      };
    },
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('AppShell', () => {
  beforeEach(() => {
    signOut.mockReset();
    listCompanies.mockReset();
    listActivePeriod.mockReset().mockResolvedValue({ data: { id: 'period-1' } });
    lookupCompanyName.mockReset().mockResolvedValue({ data: { name: 'Acme Corp' } });
  });

  it('greets the user by time of day alongside their company and email', async () => {
    // Fixed to an afternoon hour so the assertion doesn't depend on when the
    // suite happens to run.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-25T14:30:00'));
    try {
      render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

      expect(await screen.findByText(/good afternoon, acme corp/i)).toBeInTheDocument();
      expect(screen.getByText('client@example.com')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['2026-08-25T08:00:00', /good morning/i],
    ['2026-08-25T13:00:00', /good afternoon/i],
    ['2026-08-25T20:00:00', /good evening/i],
  ])('greets appropriately at %s', async (localTime, expected) => {
    jest.useFakeTimers().setSystemTime(new Date(localTime));
    try {
      render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

      expect(await screen.findByText(expected)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the AWS tab and the Uploaded Files tab for a client', async () => {
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /uploaded files/i })).toBeInTheDocument();
  });

  it('switches to the Uploaded Files tab when clicked', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /uploaded files/i }));

    expect(await screen.findByText('files-tab-content')).toBeInTheDocument();
  });

  it('shows a company switcher for staff', async () => {
    listCompanies.mockResolvedValueOnce({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
      ],
    });

    render(<AppShell userId="staff-1" role="staff" companyId={null} userEmail="staff@example.com" />);

    expect(await screen.findByLabelText(/viewing company/i)).toBeInTheDocument();
  });

  it('signs the user out when Sign out is clicked', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(signOut).toHaveBeenCalled();
  });

  it('shows the Azure tab and the Compare tab, and switches to each', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    expect(await screen.findByText('compare-tab-content')).toBeInTheDocument();
  });

  it('shows the Google Cloud and Snowflake tabs, and switches to each', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /google cloud/i }));
    expect(await screen.findByText('report-tab-content for gcp')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^snowflake$/i }));
    expect(await screen.findByText('report-tab-content for snowflake')).toBeInTheDocument();
  });

  it('only shows the Archive this period button on the 4 cloud-provider tabs', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    expect(screen.getByRole('button', { name: /archive this period/i })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    await screen.findByText('compare-tab-content');
    expect(screen.queryByRole('button', { name: /archive this period/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /uploaded files/i }));
    await screen.findByText('files-tab-content');
    expect(screen.queryByRole('button', { name: /archive this period/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /google cloud/i }));
    await screen.findByText('report-tab-content for gcp');
    expect(screen.getByRole('button', { name: /archive this period/i })).toBeInTheDocument();
  });

  it('shows the Notes & Follow-ups tab for a client, but not the Admin tab', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=false')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin tab for staff, with Notes marked isStaff=true', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} userEmail="staff@example.com" />);

    // Staff start in the admin portal, so reaching a client's Notes means
    // mirroring that company first.
    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c1');

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=true')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/viewing company/i), '__admin_portal__');
    await user.click(screen.getByRole('tab', { name: /^admin$/i }));
    // The three admin screens are now sub-tabs, so only Companies shows first
    // and the others must be reachable rather than stacked below it.
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
    expect(screen.queryByText('admin-users-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^users$/i }));
    expect(await screen.findByText('admin-users-content')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /email management/i }));
    expect(await screen.findByText('admin-user-emails-content')).toBeInTheDocument();
  });

  it("shows the logged-in user's email in the top bar", async () => {
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    expect(await screen.findByText('client@example.com')).toBeInTheDocument();
  });

  it('shows the Admin tab and company switcher for an admin, same as staff', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="admin-1" role="admin" companyId={null} userEmail="admin@example.com" />);

    expect(await screen.findByLabelText(/viewing company/i)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^admin$/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
  });

  it('starts staff in the Admin Portal, showing only the admin tabs', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    render(<AppShell userId="staff-1" role="staff" companyId={null} userEmail="staff@example.com" />);

    expect(await screen.findByRole('tab', { name: /support requests/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^admin$/i })).toBeInTheDocument();

    // Nothing company-scoped belongs here -- that is the whole point of the mode.
    expect(screen.queryByRole('tab', { name: /amazon|aws/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /compare/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /line items/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /uploaded files/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /archive/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('hides the admin tabs while mirroring a client, and restores them on the way back', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="admin-1" role="admin" companyId={null} userEmail="admin@example.com" />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c1');

    // Mirroring shows the client's portal, so the admin tools must not be
    // sitting alongside it.
    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /support requests/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^admin$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /settings/i })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/viewing company/i), '__admin_portal__');

    expect(await screen.findByRole('tab', { name: /support requests/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('leaves a client portal tab behind when switching into the Admin Portal', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="admin-1" role="admin" companyId={null} userEmail="admin@example.com" />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c1');
    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /settings/i }));
    expect(await screen.findByText('settings-tab-content')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/viewing company/i), '__admin_portal__');

    // Settings no longer exists in this mode, so staying on it would render a
    // tab that isn't in the strip.
    expect(await screen.findByText('support-requests-content')).toBeInTheDocument();
    expect(screen.queryByText('settings-tab-content')).not.toBeInTheDocument();
  });

  it('returns to a report tab when leaving the Admin Portal from an admin tab', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="admin-1" role="admin" companyId={null} userEmail="admin@example.com" />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.click(screen.getByRole('tab', { name: /^admin$/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c1');

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.queryByText('admin-companies-content')).not.toBeInTheDocument();
  });

  it('names the Admin Portal in the greeting instead of leaving it blank', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    render(<AppShell userId="admin-1" role="admin" companyId={null} userEmail="admin@example.com" />);

    // Matched with the greeting attached, so this can't pass on the dropdown
    // option that also reads "Admin Portal".
    expect(await screen.findByText(/Good (morning|afternoon|evening), Admin Portal/)).toBeInTheDocument();
  });

  it('shows the Archive tab and switches to it', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /archive/i }));
    expect(await screen.findByText('archive-tab-content')).toBeInTheDocument();
  });

  it('shows the Settings tab for a client (available to everyone with company access)', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /settings/i }));
    expect(await screen.findByText('settings-tab-content')).toBeInTheDocument();
  });

  it('shows an Overview/Resources/IAM Users sub-tab strip on the AWS tab, defaulting to Overview', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.queryByText('aws-resources-tab-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /resources/i }));
    expect(await screen.findByText('aws-resources-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for aws')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /iam users/i }));
    expect(await screen.findByText('aws-iam-users-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('aws-resources-tab-content')).not.toBeInTheDocument();
  });

  it('shows a Cost Leakage sub-tab under AWS, defaulting to Overview', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.queryByText('findings-tab-content for aws cost-leakage')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Cost Leakage' }));
    expect(await screen.findByText('findings-tab-content for aws cost-leakage')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for aws')).not.toBeInTheDocument();
  });

  it('shows a Security Checks sub-tab under AWS, defaulting to Overview', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.queryByText('findings-tab-content for aws security-checks')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Security Checks' }));
    expect(await screen.findByText('findings-tab-content for aws security-checks')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for aws')).not.toBeInTheDocument();
  });

  it('shows an Overview/Resources/Users sub-tab strip on the Azure tab, defaulting to Overview', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();
    expect(screen.queryByText('azure-resources-tab-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^resources$/i }));
    expect(await screen.findByText('azure-resources-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for azure')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^users$/i }));
    expect(await screen.findByText('azure-users-tab-content')).toBeInTheDocument();
    expect(screen.queryByText('azure-resources-tab-content')).not.toBeInTheDocument();
  });

  it('shows a Cost Leakage sub-tab under Azure', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();
    expect(screen.queryByText('findings-tab-content for azure cost-leakage')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Cost Leakage' }));
    expect(await screen.findByText('findings-tab-content for azure cost-leakage')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for azure')).not.toBeInTheDocument();
  });

  it('shows a Security Checks sub-tab under Azure', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();
    expect(screen.queryByText('findings-tab-content for azure security-checks')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Security Checks' }));
    expect(await screen.findByText('findings-tab-content for azure security-checks')).toBeInTheDocument();
    expect(screen.queryByText('report-tab-content for azure')).not.toBeInTheDocument();
  });

  it('resets the archived-period view and line-items filter when switching companies', async () => {
    listCompanies.mockResolvedValue({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} userEmail="staff@example.com" />);

    await screen.findByRole('option', { name: 'Acme Corp' });
    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c1');

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /archive/i }));
    await user.click(screen.getByRole('button', { name: /select archived period/i }));

    expect(await screen.findByText('Viewing archived period')).toBeInTheDocument();

    listActivePeriod.mockClear();
    await user.selectOptions(screen.getByLabelText(/viewing company/i), 'c2');

    await waitFor(() => expect(listActivePeriod).toHaveBeenCalled());
    expect(screen.queryByText('Viewing archived period')).not.toBeInTheDocument();
  });

  it('archives the current period on confirm and surfaces an error if the request fails', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'No active billing period found for company c1' }),
    });
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" userEmail="client@example.com" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('button', { name: /archive this period/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/periods/archive',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('No active billing period found for company c1');

    confirmSpy.mockRestore();
  });
});
