'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { UploadedFile } from '@/lib/types';
import UploadForm from '@/components/upload/UploadForm';
import styles from './UploadedFilesList.module.css';

interface UploadedFilesListProps {
  companyId: string;
}

const STATUS_LABELS: Record<UploadedFile['status'], string> = {
  processing: 'Processing',
  processed: 'Processed',
  error: 'Error',
};

export default function UploadedFilesList({ companyId }: UploadedFilesListProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);

  const loadFiles = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('uploaded_files')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    setFiles(data ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  return (
    <div className={styles.wrapper}>
      <UploadForm companyId={companyId} onUploaded={loadFiles} />

      {loading ? (
        <p>Loading files…</p>
      ) : files.length === 0 ? (
        <p>No files uploaded yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>File</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.id}>
                <td>{file.filename}</td>
                <td>{file.cloud_provider === 'aws' ? 'AWS' : 'Azure'}</td>
                <td>
                  <span>{STATUS_LABELS[file.status]}</span>
                  {file.status === 'processed' && file.row_count !== null && (
                    <>
                      {' — '}
                      <span>{file.row_count} rows</span>
                    </>
                  )}
                  {file.status === 'error' && file.error_message && (
                    <span className={styles.errorMessage}> — {file.error_message}</span>
                  )}
                </td>
                <td>{new Date(file.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
