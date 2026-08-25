import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AzureResourcesTab from './AzureResourcesTab';

const emptyResource = { data: [], error: null };
const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', tenantId: 't1', clientId: 'c1', subscriptionId: 's1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    virtualMachines: emptyResource,
    functionApps: emptyResource,
    containerGroups: emptyResource,
    sqlDatabases: emptyResource,
    cosmosDbAccounts: emptyResource,
    apiManagementServices: emptyResource,
    storageAccounts: emptyResource,
    ...overrides,
  };
}

describe('AzureResourcesTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved Azure connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  describe('configurable tag column', () => {
    // One VM (tags inline) so the column is covered on the ARM tags path.
    const taggedResponse = (tagKey: string) =>
      makeResponse({
        tagKey,
        virtualMachines: {
          data: [
            {
              name: 'web-vm-1',
              vmSize: 'Standard_B2s',
              provisioningState: 'Succeeded',
              resourceGroup: 'rg-prod',
              location: 'eastus',
              timeCreated: '2026-01-01T00:00:00.000Z',
              tagValue: 'CC-1234',
            },
          ],
          error: null,
        },
        storageAccounts: {
          data: [
            {
              name: 'mystorageacct',
              resourceGroup: 'rg-prod',
              location: 'eastus',
              kind: 'StorageV2',
              skuName: 'Standard_LRS',
              creationTime: '2026-01-01T00:00:00.000Z',
              tagValue: null,
            },
          ],
          error: null,
        },
      });

    it('heads the column with the configured tag key and shows the value', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => taggedResponse('CostCenter') });

      render(<AzureResourcesTab companyId="company-1" />);

      await screen.findByText('web-vm-1');
      expect(screen.getAllByRole('columnheader', { name: 'CostCenter' }).length).toBeGreaterThan(0);
      expect(screen.getByText('CC-1234')).toBeInTheDocument();
    });

    it('shows a dash for a resource missing the configured tag', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => taggedResponse('CostCenter') });

      render(<AzureResourcesTab companyId="company-1" />);

      const storageRow = (await screen.findByText('mystorageacct')).closest('tr');
      expect(storageRow).toHaveTextContent('—');
    });

    it('omits the column everywhere when no tag key is configured', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => taggedResponse('') });

      render(<AzureResourcesTab companyId="company-1" />);

      await screen.findByText('web-vm-1');
      expect(screen.queryByRole('columnheader', { name: 'CostCenter' })).not.toBeInTheDocument();
      expect(screen.queryByText('CC-1234')).not.toBeInTheDocument();
    });
  });

  it('renders rows for each grid when data is present', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: {
              data: [
                {
                  name: 'web-vm-1',
                  vmSize: 'Standard_B2s',
                  provisioningState: 'Succeeded',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  timeCreated: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
            storageAccounts: {
              data: [
                {
                  name: 'mystorageacct',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  kind: 'StorageV2',
                  skuName: 'Standard_LRS',
                  creationTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText('web-vm-1')).toBeInTheDocument();
    expect(screen.getByText('Standard_B2s')).toBeInTheDocument();
    expect(screen.getByText('mystorageacct')).toBeInTheDocument();
    expect(screen.getByText('No Function Apps found.')).toBeInTheDocument();
  });

  it('shows a per-grid error without hiding other grids', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: { data: [], error: 'AuthorizationFailed: the client does not have permission' },
            storageAccounts: {
              data: [{ name: 'mystorageacct', resourceGroup: 'rg-prod', location: 'eastus', kind: null, skuName: null, creationTime: null }],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/authorizationfailed/i);
    expect(screen.getByText('mystorageacct')).toBeInTheDocument();
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AzureResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('links the verify icon to a pre-filled mailto for that resource', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            virtualMachines: {
              data: [
                {
                  name: 'web-vm-1',
                  vmSize: 'Standard_B2s',
                  provisioningState: 'Succeeded',
                  resourceGroup: 'rg-prod',
                  location: 'eastus',
                  timeCreated: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText('web-vm-1');
    const verifyLink = screen.getByRole('link', { name: /email to verify this virtual machine, web-vm-1/i });
    const href = decodeURIComponent(verifyLink.getAttribute('href') ?? '');
    expect(href).toContain('mailto:?subject=Verify AWS resource: Virtual Machine web-vm-1');
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's resources", async () => {
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
    render(<AzureResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/azure/resources?companyId=company-1&credentialId=conn-2')
    );
  });
});
