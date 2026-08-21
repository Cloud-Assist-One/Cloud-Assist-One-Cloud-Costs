'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company } from '@/lib/types';
import styles from './AdminCompanies.module.css';

export default function AdminCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            <li key={company.id}>{company.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
