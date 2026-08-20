import { render, screen, waitFor } from '@testing-library/react';
import UploadedFilesList from './UploadedFilesList';

const listFiles = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: (...args: unknown[]) => listFiles(...args),
        }),
      }),
    }),
  }),
}));

describe('UploadedFilesList', () => {
  beforeEach(() => {
    listFiles.mockReset();
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
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText('july-aws.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Processed')).toBeInTheDocument();
    expect(screen.getByText('42 rows')).toBeInTheDocument();
  });

  it('shows the error message for a failed upload', async () => {
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

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText('bad.xlsx')).toBeInTheDocument();
    expect(screen.getByText(/could not find a "cost" column/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no files', async () => {
    listFiles.mockResolvedValueOnce({ data: [] });

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText(/no files uploaded yet/i)).toBeInTheDocument();
  });
});
