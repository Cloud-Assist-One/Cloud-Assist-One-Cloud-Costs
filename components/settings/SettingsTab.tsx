'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './SettingsTab.module.css';

interface SettingsTabProps {
  companyId: string;
}

interface ConnectionStatus {
  connected: boolean;
  region?: string | null;
  accessKeyIdMasked?: string | null;
}

export default function SettingsTab({ companyId }: SettingsTabProps) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const loadStatus = useCallback(async () => {
    const response = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
    const body = await response.json();
    return body as ConnectionStatus;
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const result = await loadStatus();
      if (!cancelled) {
        setStatus(result);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    const response = await fetch('/api/settings/aws-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, accessKeyId, secretAccessKey, region }),
    });
    const body = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not save the AWS connection.');
      return;
    }
    setStatus(body);
    setEditing(false);
    setAccessKeyId('');
    setSecretAccessKey('');
  }

  async function handleDisconnect() {
    setError(null);
    setDisconnecting(true);
    const response = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`, { method: 'DELETE' });
    const body = await response.json();
    setDisconnecting(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not disconnect AWS.');
      return;
    }
    setStatus({ connected: false });
    setConfirmingDisconnect(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div className={styles.wrapper}>
      <h3>AWS</h3>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {status?.connected && !editing ? (
        <div className={styles.connectedCard}>
          <p>
            AWS connected — Access key {status.accessKeyIdMasked}, region {status.region}
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => setEditing(true)}>
              Replace credentials
            </button>
            {confirmingDisconnect ? (
              <span className={styles.confirmDisconnect}>
                <span>Disconnect AWS for this company?</span>
                <button type="button" className={styles.dangerButton} disabled={disconnecting} onClick={handleDisconnect}>
                  {disconnecting ? 'Disconnecting…' : 'Confirm disconnect'}
                </button>
                <button type="button" onClick={() => setConfirmingDisconnect(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className={styles.dangerButton} onClick={() => setConfirmingDisconnect(true)}>
                Disconnect
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.form}>
          <label htmlFor="aws-access-key-id">Access key ID</label>
          <input
            id="aws-access-key-id"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
          />

          <label htmlFor="aws-secret-access-key">Secret access key</label>
          <input
            id="aws-secret-access-key"
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
          />

          <label htmlFor="aws-region">Region</label>
          <input id="aws-region" value={region} onChange={(e) => setRegion(e.target.value)} />

          <div className={styles.actions}>
            <button type="button" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {status?.connected && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
