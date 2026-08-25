import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PullBillingModal from './PullBillingModal';

const oneConnection = [{ id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' }];
const twoConnections = [
  ...oneConnection,
  { id: 'conn-2', label: 'Staging', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2' },
];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe('PullBillingModal', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a message when there are no saved AWS connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: [] }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    expect(await screen.findByText(/no aws connection found/i)).toBeInTheDocument();
  });

  it('hides the account picker when there is only one connection', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: oneConnection }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    await screen.findByLabelText(/billing month/i);
    expect(screen.queryByLabelText(/account/i)).not.toBeInTheDocument();
  });

  it('shows the account picker when there is more than one connection', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: twoConnections }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    expect(await screen.findByLabelText(/account/i)).toBeInTheDocument();
  });

  it('posts the selected connection when a non-default account is chosen', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: twoConnections }))
      .mockResolvedValueOnce(jsonResponse({ uploadedFileId: 'file-1', status: 'processed', rowCount: 4 }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    const now = new Date();
    const defaultBillingMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await screen.findByLabelText(/account/i);
    await userEvent.selectOptions(screen.getByLabelText(/account/i), 'conn-2');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));

    expect(await screen.findByText('Pulled 4 rows.')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/aws/pull-billing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          companyId: 'company-1',
          credentialId: 'conn-2',
          billingMonth: defaultBillingMonth,
          archiveFirst: false,
        }),
      })
    );
  });

  it('posts archiveFirst: false when Ok is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(jsonResponse({ uploadedFileId: 'file-1', status: 'processed', rowCount: 12 }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    const year = new Date().getFullYear();
    await screen.findByLabelText(/billing month/i);
    await userEvent.selectOptions(screen.getByLabelText(/billing month/i), `${year}-01-01`);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));

    expect(await screen.findByText('Pulled 12 rows.')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/aws/pull-billing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          companyId: 'company-1',
          credentialId: 'conn-1',
          billingMonth: `${year}-01-01`,
          archiveFirst: false,
        }),
      })
    );
  });

  it('posts archiveFirst: true when Yes, but Archive Current View is clicked, calls onPulled as soon as the pull completes, and calls onClose on Done', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(
        jsonResponse({ uploadedFileId: 'file-1', status: 'processed', rowCount: 8, newPeriodId: 'period-2' })
      );

    const onPulled = jest.fn();
    const onClose = jest.fn();
    render(<PullBillingModal companyId="company-1" onClose={onClose} onPulled={onPulled} />);

    await screen.findByLabelText(/billing month/i);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, but Archive Current View' }));

    expect(await screen.findByText('Pulled 8 rows.')).toBeInTheDocument();
    expect(onPulled).toHaveBeenCalledWith({ rowCount: 8, newPeriodId: 'period-2' });
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error message when the pull fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(jsonResponse({ error: 'AWS Cost Explorer: Access denied.' }, false));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    await screen.findByLabelText(/billing month/i);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));

    expect(await screen.findByText('AWS Cost Explorer: Access denied.')).toBeInTheDocument();
  });
});
