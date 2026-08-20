'use client';

import { useState, FormEvent } from 'react';
import type { CloudProvider } from '@/lib/types';
import styles from './UploadForm.module.css';

interface UploadFormProps {
  companyId: string;
  onUploaded?: () => void;
}

type Status = 'idle' | 'uploading' | 'error';

export default function UploadForm({ companyId, onUploaded }: UploadFormProps) {
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('aws');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;

    setStatus('uploading');
    setErrors([]);
    setSuccessMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('cloudProvider', cloudProvider);
    formData.append('companyId', companyId);

    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    const body = await response.json();

    if (!response.ok) {
      setStatus('error');
      setErrors([body.error ?? 'Upload failed.']);
      return;
    }

    if (body.status === 'error') {
      setStatus('error');
      setErrors(body.errors ?? ['Could not process the file.']);
      return;
    }

    setStatus('idle');
    setFile(null);
    setSuccessMessage(`Uploaded — ${body.rowCount} rows processed.`);
    onUploaded?.();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h3>Upload a billing file</h3>

      <label htmlFor="cloud-provider">Cloud provider</label>
      <select
        id="cloud-provider"
        value={cloudProvider}
        onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
      >
        <option value="aws">AWS</option>
        <option value="azure">Azure</option>
      </select>

      <label htmlFor="upload-file">File</label>
      <input
        id="upload-file"
        type="file"
        accept=".xlsx,.csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        required
      />

      {errors.length > 0 && (
        <div role="alert" className={styles.error}>
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      {successMessage && (
        <p role="status" className={styles.status}>
          {successMessage}
        </p>
      )}

      <button type="submit" disabled={status === 'uploading'}>
        {status === 'uploading' ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}
