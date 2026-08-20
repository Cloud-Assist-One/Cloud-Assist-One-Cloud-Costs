import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UploadForm from './UploadForm';

describe('UploadForm', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uploads a file and calls onUploaded on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ uploadedFileId: 'file-1', status: 'processed', rowCount: 3 }),
    });
    const onUploaded = jest.fn();
    const user = userEvent.setup();
    render(<UploadForm companyId="company-1" onUploaded={onUploaded} />);

    const file = new File(['a,b,c'], 'aws-export.xlsx', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText(/file/i), file);
    await user.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/upload', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/3 rows/i)).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalled();
  });

  it('shows the parser errors when the file fails to process', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ uploadedFileId: 'file-1', status: 'error', errors: ['Could not find a "Cost" column.'] }),
    });
    const user = userEvent.setup();
    render(<UploadForm companyId="company-1" />);

    const file = new File(['a,b,c'], 'bad-export.xlsx', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText(/file/i), file);
    await user.click(screen.getByRole('button', { name: /upload/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not find a "cost" column/i);
  });
});
