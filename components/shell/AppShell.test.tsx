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
jest.mock('./../reports/TrendSidebar', () => ({
  __esModule: true,
  default: () => <div>trend-sidebar-content</div>,
}));
jest.mock('./../notes/NotesFeed', () => ({
  __esModule: true,
  default: ({ isStaff }: { isStaff: boolean }) => <div>notes-feed-content isStaff={String(isStaff)}</div>,
}));
jest.mock('./../admin/AdminCompanies', () => ({
  __esModule: true,
  default: () => <div>admin-companies-content</div>,
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
jest.mock('./../reports/AwsResourcesTab', () => ({
  __esModule: true,
  default: () => <div>aws-resources-tab-content</div>,
}));
jest.mock('./../reports/AwsIamUsersTab', () => ({
  __esModule: true,
  default: () => <div>aws-iam-users-tab-content</div>,
}));

const signOut = jest.fn();
const listCompanies = jest.fn();
const listActivePeriod = jest.fn();

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
      return { select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }) };
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

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=true')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /admin/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
    expect(screen.getByText('admin-users-content')).toBeInTheDocument();
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
    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /admin/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
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

  it('resets the archived-period view and line-items filter when switching companies', async () => {
    listCompanies.mockResolvedValue({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} userEmail="staff@example.com" />);

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
