import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UploadedFilesList from './UploadedFilesList';

const listFiles = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: (...args: unknown[]) => listFiles(...args),
          }),
        }),
      }),
    }),
  }),
}));

describe('UploadedFilesList', () => {
  beforeEach(() => {
    listFiles.mockReset();
    global.fetch = jest.fn();
  });

  it('lists uploaded files with their status', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-1',
          company_id: 'company-1',
          cloud_provider: 'aws',
          filename: 'july-aws.xlsx',
          storage_path: 'company-1/july-aws.xlsx',
          status: 'processed',
          error_message: null,
          row_count: 42,
          uploaded_by: 'user-1',
          created_at: '2026-07-01T00:00:00.000Z',
          billing_month: '2026-07-01',
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />);

    expect(await screen.findByText('july-aws.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Processed')).toBeInTheDocument();
    expect(screen.getByText('42 rows')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Amazon Web Services' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'July 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows the error message for a failed upload, with a Delete button', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-2',
          company_id: 'company-1',
          cloud_provider: 'azure',
          filename: 'bad.xlsx',
          storage_path: 'company-1/bad.xlsx',
          status: 'error',
          error_message: 'Could not find a "Cost" column.',
          row_count: null,
          uploaded_by: 'user-1',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />);

    expect(await screen.findByText('bad.xlsx')).toBeInTheDocument();
    expect(screen.getByText(/could not find a "cost" column/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('deletes an errored file after confirmation and refreshes the list', async () => {
    listFiles
      .mockResolvedValueOnce({
        data: [
          {
            id: 'file-2',
            company_id: 'company-1',
            cloud_provider: 'azure',
            filename: 'bad.xlsx',
            storage_path: 'company-1/bad.xlsx',
            status: 'error',
            error_message: 'Could not find a "Cost" column.',
            row_count: null,
            uploaded_by: 'user-1',
            created_at: '2026-07-02T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ data: [] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />);

    await screen.findByText('bad.xlsx');
    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/upload/file-2', expect.objectContaining({ method: 'DELETE' }))
    );
    await waitFor(() => expect(screen.getByText(/no files uploaded yet/i)).toBeInTheDocument());

    confirmSpy.mockRestore();
  });

  it('surfaces an error if deleting the file fails', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-2',
          company_id: 'company-1',
          cloud_provider: 'azure',
          filename: 'bad.xlsx',
          storage_path: 'company-1/bad.xlsx',
          status: 'error',
          error_message: 'Could not find a "Cost" column.',
          row_count: null,
          uploaded_by: 'user-1',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not delete the file.' }) });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />);

    await screen.findByText('bad.xlsx');
    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete the file.');

    confirmSpy.mockRestore();
  });

  it('does not show a Delete button for an errored file when read-only', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-2',
          company_id: 'company-1',
          cloud_provider: 'azure',
          filename: 'bad.xlsx',
          storage_path: 'company-1/bad.xlsx',
          status: 'error',
          error_message: 'Could not find a "Cost" column.',
          row_count: null,
          uploaded_by: 'user-1',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly />);

    await screen.findByText('bad.xlsx');
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no files', async () => {
    listFiles.mockResolvedValueOnce({ data: [] });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />);

    expect(await screen.findByText(/no files uploaded yet/i)).toBeInTheDocument();
  });

  it('hides the upload form when viewing a read-only (archived) period', async () => {
    listFiles.mockResolvedValueOnce({ data: [] });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly />);

    await screen.findByText(/no files uploaded yet/i);
    expect(screen.queryByRole('heading', { name: /upload a billing file/i })).not.toBeInTheDocument();
  });
});
