'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company } from '@/lib/types';
import styles from './AdminCompanies.module.css';

export default function AdminCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);

  const loadCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    setCompanies(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCompanies();
  }, [loadCompanies]);

  async function handleCreate() {
    if (!name.trim()) return;
    const supabase = createClient();
    await supabase.from('companies').insert({ name: name.trim() });
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
