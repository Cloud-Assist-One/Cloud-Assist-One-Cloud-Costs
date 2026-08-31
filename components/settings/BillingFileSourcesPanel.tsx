'use client';

import { useEffect, useState } from 'react';
import type { BillingFileSource, BillingSourceInspection } from '@/lib/types';
import BillingSourceInspectionReport from './BillingSourceInspectionReport';
import styles from './BillingFileSourcesPanel.module.css';

// Bucket pulls only support these two providers today (see the pull route),
// so the picker is deliberately narrower than the full CLOUD_PROVIDERS list.
type BucketProvider = 'aws' | 'azure';

const BUCKET_PROVIDERS: { value: BucketProvider; label: string }[] = [
  { value: 'aws', label: 'Amazon S3' },
  { value: 'azure', label: 'Azure Blob Storage' },
];

interface ConnectionOption {
  id: string;
  label: string;
}

interface BillingFileSourcesPanelProps {
  companyId: string;
}

export default function BillingFileSourcesPanel({ companyId }: BillingFileSourcesPanelProps) {
  const [sources, setSources] = useState<BillingFileSource[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [provider, setProvider] = useState<BucketProvider>('aws');
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [credentialId, setCredentialId] = useState('');
  const [label, setLabel] = useState('');
  const [container, setContainer] = useState('');
  const [prefix, setPrefix] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  // Keyed by source so testing a second bucket does not blank the first
  // one's report, which is the whole point when comparing two of them.
  const [inspections, setInspections] = useState<Record<string, BillingSourceInspection>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadSources() {
      setLoadingSources(true);
      try {
        const response = await fetch(`/api/settings/billing-file-sources?companyId=${companyId}`);
        const body = await response.json();
        if (cancelled) return;
        setSources(response.ok ? ((body.sources ?? []) as BillingFileSource[]) : []);
      } catch {
        if (!cancelled) setSources([]);
      } finally {
        if (!cancelled) setLoadingSources(false);
      }
    }

    loadSources();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Connections are provider-specific (aws-credentials vs azure-credentials),
  // so switching the provider picker must reload the list it's populated from.
  useEffect(() => {
    let cancelled = false;

    async function loadConnections() {
      try {
        const response = await fetch(`/api/settings/${provider}-credentials?companyId=${companyId}`);
        const body = await response.json();
        if (cancelled) return;
        const list = (body.connections ?? []) as ConnectionOption[];
        setConnections(list);
        setCredentialId(list.length > 0 ? list[0].id : '');
      } catch {
        if (!cancelled) {
          setConnections([]);
          setCredentialId('');
        }
      }
    }

    loadConnections();
    return () => {
      cancelled = true;
    };
  }, [provider, companyId]);

  async function handleAdd() {
    setError(null);
    setSaving(true);
    try {
      const response = await fetch('/api/settings/billing-file-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, credentialId, cloudProvider: provider, container, prefix, label }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Could not save this bucket.');
        return;
      }
      setSources((prev) => [body.source as BillingFileSource, ...(prev ?? [])]);
      setLabel('');
      setContainer('');
      setPrefix('');
    } catch {
      setError('Could not save this bucket.');
    } finally {
      setSaving(false);
    }
  }

  // Reads the bucket and reports what is in it, without importing any of it.
  // Deliberately separate from the pull: the pull's summary can only describe
  // an import it already committed to, which is no use when the question is
  // why there was nothing to import.
  async function handleTest(sourceId: string) {
    setTestingId(sourceId);
    setTestErrors((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    try {
      const response = await fetch(`/api/billing-sources/${sourceId}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      const body = await response.json();
      if (!response.ok) {
        // A failure here IS the answer -- the credential, the storage account
        // or the container name is wrong -- so it belongs beside the bucket
        // it is about, not in the panel-wide error above.
        setTestErrors((prev) => ({ ...prev, [sourceId]: body.error ?? 'Could not read this bucket.' }));
        setInspections((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
        return;
      }
      setInspections((prev) => ({ ...prev, [sourceId]: body.inspection as BillingSourceInspection }));
    } catch {
      setTestErrors((prev) => ({ ...prev, [sourceId]: 'Could not reach the server to test this bucket.' }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(sourceId: string) {
    setError(null);
    setDeletingId(sourceId);
    try {
      const response = await fetch(
        `/api/settings/billing-file-sources?companyId=${companyId}&sourceId=${sourceId}`,
        { method: 'DELETE' }
      );
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Could not remove this bucket.');
        return;
      }
      setSources((prev) => (prev ?? []).filter((s) => s.id !== sourceId));
      setConfirmingDeleteId(null);
    } catch {
      setError('Could not remove this bucket.');
    } finally {
      setDeletingId(null);
    }
  }

  if (loadingSources) {
    return <p>Loading…</p>;
  }

  return (
    <div className={styles.wrapper}>
      <h3>Billing file sources</h3>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {sources && sources.length > 0 ? (
        <ul className={styles.list}>
          {sources.map((source) => (
            <li key={source.id} className={styles.sourceCard}>
              <div>
                <strong>{source.label}</strong> — {source.container}
                {source.prefix ? `/${source.prefix}` : ''}
                {source.last_pulled_at && (
                  <span className={styles.lastPulled}>
                    {' '}
                    · Last pulled {new Date(source.last_pulled_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              {confirmingDeleteId === source.id ? (
                <span className={styles.confirmRemove}>
                  <span>Are you sure you want to remove this bucket?</span>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={deletingId === source.id}
                    onClick={() => handleDelete(source.id)}
                  >
                    {deletingId === source.id ? 'Removing…' : 'Confirm remove'}
                  </button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <span className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={testingId === source.id}
                    onClick={() => handleTest(source.id)}
                  >
                    {testingId === source.id ? 'Testing…' : 'Test connection'}
                  </button>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => setConfirmingDeleteId(source.id)}
                  >
                    Remove
                  </button>
                </span>
              )}

              {testErrors[source.id] && (
                <p role="alert" className={styles.testError}>
                  {testErrors[source.id]}
                </p>
              )}

              {inspections[source.id] && <BillingSourceInspectionReport inspection={inspections[source.id]} />}
            </li>
          ))}
        </ul>
      ) : (
        <p>No buckets configured yet.</p>
      )}

      <div className={styles.form}>
        <label htmlFor="billing-source-label">Label</label>
        <input id="billing-source-label" value={label} onChange={(e) => setLabel(e.target.value)} />

        <label htmlFor="billing-source-provider">Cloud provider</label>
        <select
          id="billing-source-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as BucketProvider)}
        >
          {BUCKET_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <label htmlFor="billing-source-container">
          {provider === 'azure' ? 'Storage account/Container' : 'Bucket'}
        </label>
        <input
          id="billing-source-container"
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          placeholder={provider === 'azure' ? 'account/container' : 'my-cur-bucket'}
        />

        <label htmlFor="billing-source-prefix">Prefix</label>
        <input id="billing-source-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />

        <label htmlFor="billing-source-connection">Connection</label>
        <select
          id="billing-source-connection"
          value={credentialId}
          onChange={(e) => setCredentialId(e.target.value)}
        >
          {connections.length === 0 && <option value="">No connections available</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>

        <div className={styles.actions}>
          <button type="button" disabled={saving} onClick={handleAdd}>
            {saving ? 'Adding…' : 'Add bucket'}
          </button>
        </div>
      </div>
    </div>
  );
}
