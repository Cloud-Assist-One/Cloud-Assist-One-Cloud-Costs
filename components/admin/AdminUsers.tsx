'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company, Profile } from '@/lib/types';
import styles from './AdminUsers.module.css';

export default function AdminUsers() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'client' | 'staff'>('client');
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const response = await fetch('/api/admin/users');
    const body = await response.json();
    setUsers(body.users ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('companies')
      .select('*')
      .order('name', { ascending: true })
      .then(({ data }) => {
        setCompanies(data ?? []);
        if (data && data.length > 0) setCompanyId(data[0].id);
      });
  }, []);

  function companyName(id: string | null): string {
    if (!id) return '—';
    return companies.find((c) => c.id === id)?.name ?? id;
  }

  async function handleCreate() {
    setError(null);
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
    setEmail('');
    setPassword('');
    loadUsers();
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
        <select id="new-user-role" value={role} onChange={(e) => setRole(e.target.value as 'client' | 'staff')}>
          <option value="client">Client</option>
          <option value="staff">Staff</option>
        </select>

        {role === 'client' && (
          <>
            <label htmlFor="new-user-company">Company</label>
            <select id="new-user-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </>
        )}

        {error && <p role="alert">{error}</p>}

        <button type="button" onClick={handleCreate}>
          Create user
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : users.length === 0 ? (
        <p>No users yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Company</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{companyName(u.company_id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
