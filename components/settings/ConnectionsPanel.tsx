'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './ConnectionsPanel.module.css';

export interface ConnectionField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea';
  defaultValue?: string;
}

interface ConnectionsPanelProps<TSummary extends { id: string; label: string; tagKey?: string }> {
  companyId: string;
  apiPath: string;
  fields: ConnectionField[];
  renderSummary: (connection: TSummary) => string;
}

export default function ConnectionsPanel<TSummary extends { id: string; label: string; tagKey?: string }>({
  companyId,
  apiPath,
  fields,
  renderSummary,
}: ConnectionsPanelProps<TSummary>) {
  const [connections, setConnections] = useState<TSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? '']))
  );
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Local edits to a connection's tag key, keyed by connection id. Absent
  // means "show the connection's current tagKey" — cleared again once a
  // save succeeds, so the input reflects the freshly saved value.
  const [tagKeyDrafts, setTagKeyDrafts] = useState<Record<string, string>>({});
  const [savingTagKeyId, setSavingTagKeyId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const response = await fetch(`${apiPath}?companyId=${companyId}`);
    const body = await response.json();
    return (body.connections ?? []) as TSummary[];
  }, [apiPath, companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await loadConnections();
        if (!cancelled) {
          setConnections(result);
        }
      } catch {
        if (!cancelled) {
          setError('Could not load connections.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [loadConnections]);

  async function handleAdd() {
    setError(null);
    setSaving(true);
    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, label, ...values }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Could not save the connection.');
        return;
      }
      setConnections((prev) => [...(prev ?? []), body.connection as TSummary]);
      setAdding(false);
      setLabel('');
      setValues(Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ''])));
    } catch {
      setError('Could not save the connection.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    setDeletingId(id);
    try {
      const response = await fetch(`${apiPath}?companyId=${companyId}&id=${id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Could not disconnect.');
        return;
      }
      setConnections((prev) => (prev ?? []).filter((c) => c.id !== id));
      setConfirmingDeleteId(null);
    } catch {
      setError('Could not disconnect.');
    } finally {
      setDeletingId(null);
    }
  }

  // Changing which tag is reported must not mean disconnecting and
  // re-entering the secret, so this PATCHes just the tag key rather than
  // going through the add/disconnect flow.
  async function handleSaveTagKey(id: string, tagKey: string) {
    setError(null);
    setSavingTagKeyId(id);
    try {
      const response = await fetch(apiPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, id, tagKey }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Could not update the tag key.');
        return;
      }
      setConnections((prev) => (prev ?? []).map((c) => (c.id === id ? (body.connection as TSummary) : c)));
      setTagKeyDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch {
      setError('Could not update the tag key.');
    } finally {
      setSavingTagKeyId(null);
    }
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div className={styles.wrapper}>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {connections && connections.length > 0 && (
        <ul className={styles.list}>
          {connections.map((connection) => (
            <li key={connection.id} className={styles.connectionCard}>
              <div>
                <strong>{connection.label}</strong> — {renderSummary(connection)}
              </div>
              {typeof connection.tagKey === 'string' && (
                <div className={styles.tagKeyRow}>
                  <label htmlFor={`tag-key-${connection.id}`}>Tag key</label>
                  <input
                    id={`tag-key-${connection.id}`}
                    value={tagKeyDrafts[connection.id] ?? connection.tagKey}
                    onChange={(e) =>
                      setTagKeyDrafts((prev) => ({ ...prev, [connection.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    disabled={savingTagKeyId === connection.id}
                    onClick={() =>
                      handleSaveTagKey(connection.id, tagKeyDrafts[connection.id] ?? connection.tagKey ?? '')
                    }
                  >
                    {savingTagKeyId === connection.id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
              {confirmingDeleteId === connection.id ? (
                <span className={styles.confirmDisconnect}>
                  <span>Disconnect this connection?</span>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={deletingId === connection.id}
                    onClick={() => handleDelete(connection.id)}
                  >
                    {deletingId === connection.id ? 'Disconnecting…' : 'Confirm disconnect'}
                  </button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => setConfirmingDeleteId(connection.id)}
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {connections && connections.length === 0 && !adding && <p>No connections yet.</p>}

      {adding ? (
        <div className={styles.form}>
          <label htmlFor="connection-label">Label</label>
          <input id="connection-label" value={label} onChange={(e) => setLabel(e.target.value)} />

          {fields.map((field) => (
            <div key={field.name} className={styles.fieldRow}>
              <label htmlFor={`connection-field-${field.name}`}>{field.label}</label>
              {field.type === 'textarea' ? (
                <textarea
                  id={`connection-field-${field.name}`}
                  value={values[field.name]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                />
              ) : (
                <input
                  id={`connection-field-${field.name}`}
                  type={field.type}
                  value={values[field.name]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                />
              )}
            </div>
          ))}

          <div className={styles.actions}>
            <button type="button" disabled={saving} onClick={handleAdd}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addButton} onClick={() => setAdding(true)}>
          Add connection
        </button>
      )}
    </div>
  );
}
