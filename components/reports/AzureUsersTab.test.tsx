import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AzureUsersTab from './AzureUsersTab';

const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    users: { data: [], error: null },
    ...overrides,
  };
}

describe('AzureUsersTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved Azure connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders a row for each Azure AD user', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [
                {
                  id: 'abc-123',
                  displayName: 'Jane Doe',
                  userPrincipalName: 'jane.doe@example.onmicrosoft.com',
                  createdDateTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane.doe@example.onmicrosoft.com')).toBeInTheDocument();
  });

  it('shows a Graph-permission-specific error message when the users call fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [],
              error:
                'Insufficient privileges to complete the operation. (This usually means the app registration needs the Microsoft Graph "User.Read.All" application permission, with admin consent granted -- a separate grant from the ARM "Reader" role used for the Resources tab.)',
            },
          }),
      });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/user\.read\.all/i);
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AzureUsersTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's users", async () => {
    const twoConnections = {
      connections: [
        { id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' },
        { id: 'conn-2', label: 'Client sandbox', tenantId: 't2', clientId: 'c2', subscriptionId: 's2' },
      ],
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => twoConnections })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/azure/ad-users?companyId=company-1&credentialId=conn-2')
    );
  });
});
