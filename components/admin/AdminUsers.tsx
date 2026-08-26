'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company } from '@/lib/types';
import styles from './AdminUsers.module.css';

interface AdminUsersProps {
  isAdmin?: boolean;
}

export default function AdminUsers({ isAdmin = false }: AdminUsersProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'client' | 'staff' | 'admin'>('client');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const fetchCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    return (data ?? []) as Company[];
  }, []);

  const loadCompanies = useCallback(async () => {
    const companyList = await fetchCompanies();
    setCompanies(companyList);
    // Only default to the first company when nothing is selected yet -- a
    // manual refresh (e.g. to pick up a company just created elsewhere)
    // must not silently discard whichever company is already chosen.
    setCompanyId((prev) => prev || (companyList.length > 0 ? companyList[0].id : ''));
  }, [fetchCompanies]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const companyList = await fetchCompanies();
      if (!cancelled) {
        setCompanies(companyList);
        if (companyList.length > 0) setCompanyId(companyList[0].id);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchCompanies]);

  async function handleCreate() {
    setError(null);
    setCreated(null);
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, role, companyId: role === 'client' ? companyId : undefined }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Could not create the user.');
      return;
    }
    // The list of accounts now lives in Email Management, so success has to be
    // stated here -- cleared fields alone read as "nothing happened".
    setCreated(email);
    setEmail('');
    setPassword('');
  }

  return (
    <div className={styles.wrapper}>
      <h3>Users</h3>
      <div className={styles.addForm}>
        <label htmlFor="new-user-email">Email</label>
        <input id="new-user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="new-user-password">Password</label>
        <input id="new-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />

        <label htmlFor="new-user-role">Role</label>
        <select
          id="new-user-role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'client' | 'staff' | 'admin')}
        >
          <option value="client">Client</option>
          <option value="staff">Staff</option>
          {isAdmin && <option value="admin">Admin</option>}
        </select>

        {role === 'client' && (
          <>
            <label htmlFor="new-user-company">Company</label>
            <div className={styles.companyRow}>
              <select id="new-user-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
              <button type="button" className={styles.refreshButton} onClick={loadCompanies}>
                Refresh companies
              </button>
            </div>
          </>
        )}

        {error && <p role="alert">{error}</p>}
        {created && <p role="status">Created {created}. It now appears under Email Management.</p>}

        <button type="button" onClick={handleCreate}>
          Create user
        </button>
      </div>
    </div>
  );
}
