import { render, screen } from '@testing-library/react';
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
  default: () => <div>archive-tab-content</div>,
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
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /uploaded files/i })).toBeInTheDocument();
  });

  it('switches to the Uploaded Files tab when clicked', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

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

    render(<AppShell userId="staff-1" role="staff" companyId={null} />);

    expect(await screen.findByLabelText(/viewing company/i)).toBeInTheDocument();
  });

  it('signs the user out when Sign out is clicked', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(signOut).toHaveBeenCalled();
  });

  it('shows the Azure tab and the Compare tab, and switches to each', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    expect(await screen.findByText('compare-tab-content')).toBeInTheDocument();
  });

  it('shows the Notes & Follow-ups tab for a client, but not the Admin tab', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=false')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin tab for staff, with Notes marked isStaff=true', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=true')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /admin/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
    expect(screen.getByText('admin-users-content')).toBeInTheDocument();
  });

  it('shows the Archive tab and switches to it', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /archive/i }));
    expect(await screen.findByText('archive-tab-content')).toBeInTheDocument();
  });
});
