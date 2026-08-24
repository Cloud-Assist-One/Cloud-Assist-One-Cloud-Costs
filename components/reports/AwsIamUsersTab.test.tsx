import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsIamUsersTab from './AwsIamUsersTab';

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    users: { data: [], error: null },
    ...overrides,
  };
}

describe('AwsIamUsersTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when AWS has not been set up', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connected: false }) });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders a row for each IAM user', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeResponse({
          users: {
            data: [
              {
                userName: 'jdoe',
                userId: 'AIDAEXAMPLE',
                arn: 'arn:aws:iam::123456789012:user/jdoe',
                path: '/',
                createDate: '2026-01-01T00:00:00.000Z',
                passwordLastUsed: '2026-08-01T00:00:00.000Z',
              },
            ],
            error: null,
          },
        }),
    });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText('jdoe')).toBeInTheDocument();
    expect(screen.getByText('AIDAEXAMPLE')).toBeInTheDocument();
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('links the verify icon to a pre-filled mailto for that IAM user', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeResponse({
          users: {
            data: [
              {
                userName: 'jdoe',
                userId: 'AIDAEXAMPLE',
                arn: 'arn:aws:iam::123456789012:user/jdoe',
                path: '/',
                createDate: '2026-01-01T00:00:00.000Z',
                passwordLastUsed: null,
              },
            ],
            error: null,
          },
        }),
    });

    render(<AwsIamUsersTab companyId="company-1" />);

    await screen.findByText('jdoe');
    const verifyLink = screen.getByRole('link', { name: /email to verify this iam user, jdoe/i });
    const href = decodeURIComponent(verifyLink.getAttribute('href') ?? '');
    expect(href).toContain('mailto:?subject=Verify AWS resource: IAM user jdoe');
    expect(href).toContain('Please verify this IAM user "jdoe" is valid and let me know what it is being used for.');
  });

  it('shows an error without hiding the rest of the page', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => makeResponse({ users: { data: [], error: 'AccessDenied: not authorized to perform iam:ListUsers' } }),
    });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/accessdenied/i);
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AwsIamUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });
});
