import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsTab from './SettingsTab';

describe('SettingsTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a form to connect AWS when not yet connected', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connected: false }) });

    render(<SettingsTab companyId="company-1" />);

    expect(await screen.findByLabelText(/access key id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secret access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/region/i)).toBeInTheDocument();
    expect(screen.queryByText(/aws connected/i)).not.toBeInTheDocument();
  });

  it('shows the masked connection summary when already connected', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ connected: true, region: 'us-east-1', accessKeyIdMasked: 'AKIA********WXYZ' }),
    });

    render(<SettingsTab companyId="company-1" />);

    expect(await screen.findByText(/AWS connected/i)).toBeInTheDocument();
    expect(screen.getByText(/AKIA\*+WXYZ/)).toBeInTheDocument();
    expect(screen.getByText(/us-east-1/)).toBeInTheDocument();
  });

  it('saves new credentials and shows the connected summary', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connected: false }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: true, region: 'us-west-2', accessKeyIdMasked: 'AKIA********WXYZ' }),
      });

    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByLabelText(/access key id/i);
    await user.type(screen.getByLabelText(/access key id/i), 'AKIAEXAMPLEWXYZ');
    await user.type(screen.getByLabelText(/secret access key/i), 'super-secret-value');
    await user.clear(screen.getByLabelText(/region/i));
    await user.type(screen.getByLabelText(/region/i), 'us-west-2');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/aws-credentials',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByText(/AWS connected/i)).toBeInTheDocument();
  });

  it('disconnects after confirmation', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: true, region: 'us-east-1', accessKeyIdMasked: 'AKIA********WXYZ' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });

    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText(/AWS connected/i);
    await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
    await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/aws-credentials?companyId=company-1',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
    expect(await screen.findByLabelText(/access key id/i)).toBeInTheDocument();
  });

  it('surfaces an error if saving fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connected: false }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'region must look like an AWS region, e.g. us-east-1.' }) });

    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByLabelText(/access key id/i);
    await user.type(screen.getByLabelText(/access key id/i), 'AKIAEXAMPLE');
    await user.type(screen.getByLabelText(/secret access key/i), 'secret');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/must look like an aws region/i);
  });
});
