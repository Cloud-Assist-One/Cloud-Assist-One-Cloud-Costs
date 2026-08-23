'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { UploadedFile } from '@/lib/types';
import { CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import UploadForm from '@/components/upload/UploadForm';
import styles from './UploadedFilesList.module.css';

interface UploadedFilesListProps {
  companyId: string;
  periodId: string;
  isReadOnly: boolean;
}

const STATUS_LABELS: Record<UploadedFile['status'], string> = {
  processing: 'Processing',
  processed: 'Processed',
  error: 'Error',
};

function formatBillingMonth(billingMonth: string | null): string {
  if (!billingMonth) return '—';
  return new Date(`${billingMonth}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function UploadedFilesList({ companyId, periodId, isReadOnly }: UploadedFilesListProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchFiles = useCallback(async (onComplete?: (files: UploadedFile[]) => void) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('uploaded_files')
      .select('*')
      .eq('company_id', companyId)
      .eq('period_id', periodId)
      .order('created_at', { ascending: false });
    const fileList = data ?? [];
    if (onComplete) {
      onComplete(fileList);
    }
    return fileList;
  }, [companyId, periodId]);

  const loadFiles = useCallback(async () => {
    const fileList = await fetchFiles();
    setFiles(fileList);
    setLoading(false);
  }, [fetchFiles]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const fileList = await fetchFiles();
      if (!cancelled) {
        setFiles(fileList);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchFiles]);

  async function handleDelete(file: UploadedFile) {
    const confirmed = window.confirm(`Delete "${file.filename}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeleteError(null);
    const response = await fetch(`/api/upload/${file.id}`, { method: 'DELETE' });
    const body = await response.json();
    if (!response.ok) {
      setDeleteError(body.error ?? 'Could not delete the file.');
      return;
    }
    loadFiles();
  }

  return (
    <div className={styles.wrapper}>
      {!isReadOnly && <UploadForm companyId={companyId} onUploaded={loadFiles} />}

      {deleteError && (
        <p role="alert" className={styles.errorMessage}>
          {deleteError}
        </p>
      )}

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
              <th>Billing Month</th>
              <th>Status</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.id}>
                <td>{file.filename}</td>
                <td>{CLOUD_PROVIDER_LABELS[file.cloud_provider]}</td>
                <td>{formatBillingMonth(file.billing_month)}</td>
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
                <td>
                  {!isReadOnly && file.status === 'error' && (
                    <button type="button" className={styles.deleteButton} onClick={() => handleDelete(file)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
