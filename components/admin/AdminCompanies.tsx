'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company } from '@/lib/types';
import styles from './AdminCompanies.module.css';

interface AdminCompaniesProps {
  isAdmin?: boolean;
}

export default function AdminCompanies({ isAdmin = false }: AdminCompaniesProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetchCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    return (data ?? []) as Company[];
  }, []);

  const loadCompanies = useCallback(async () => {
    const companyList = await fetchCompanies();
    setCompanies(companyList);
    setLoading(false);
  }, [fetchCompanies]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const companyList = await fetchCompanies();
      if (!cancelled) {
        setCompanies(companyList);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchCompanies]);

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    const supabase = createClient();
    const { error: insertError } = await supabase.from('companies').insert({ name: name.trim() });
    if (insertError) {
      setError(insertError.message ?? 'Could not create the company.');
      return;
    }
    setName('');
    loadCompanies();
  }

  function startDelete(companyId: string) {
    setDeletingId(companyId);
    setConfirmText('');
    setError(null);
  }

  function cancelDelete() {
    setDeletingId(null);
    setConfirmText('');
  }

  async function confirmDelete(company: Company) {
    if (confirmText !== company.name) return;
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/admin/companies/${company.id}`, { method: 'DELETE' });
    const body = await response.json();
    setDeleting(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not delete the company.');
      return;
    }
    setDeletingId(null);
    setConfirmText('');
    loadCompanies();
  }

  return (
    <div className={styles.wrapper}>
      <h3>Companies</h3>
      <div className={styles.addForm}>
        <label htmlFor="new-company-name">Company name</label>
        <input id="new-company-name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={handleCreate}>
          Create company
        </button>
      </div>

      {error && <p role="alert">{error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : companies.length === 0 ? (
        <p>No companies yet.</p>
      ) : (
        <ul className={styles.list}>
          {companies.map((company) => (
            <li key={company.id} className={styles.companyRow}>
              <span>{company.name}</span>
              {isAdmin &&
                (deletingId === company.id ? (
                  <div className={styles.confirmDelete}>
                    <label htmlFor={`confirm-delete-${company.id}`}>
                      Type &quot;{company.name}&quot; to permanently delete it and all its data
                    </label>
                    <input
                      id={`confirm-delete-${company.id}`}
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.deleteButton}
                      disabled={confirmText !== company.name || deleting}
                      onClick={() => confirmDelete(company)}
                    >
                      {deleting ? 'Deleting…' : 'Confirm delete'}
                    </button>
                    <button type="button" onClick={cancelDelete}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className={styles.deleteButton} onClick={() => startDelete(company.id)}>
                    Delete
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
