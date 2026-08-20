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

const signOut = jest.fn();
const listCompanies = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signOut: (...args: unknown[]) => signOut(...args) },
    from: () => ({ select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }) }),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('AppShell', () => {
  beforeEach(() => {
    signOut.mockReset();
    listCompanies.mockReset();
  });

  it('shows the AWS tab and the Uploaded Files tab for a client', async () => {
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    expect(screen.getByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /uploaded files/i })).toBeInTheDocument();
  });

  it('switches to the Uploaded Files tab when clicked', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('tab', { name: /uploaded files/i }));

    expect(screen.getByText('files-tab-content')).toBeInTheDocument();
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

    await user.click(screen.getByRole('tab', { name: /azure/i }));
    expect(screen.getByText('report-tab-content for azure')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    expect(screen.getByText('compare-tab-content')).toBeInTheDocument();
  });
});
