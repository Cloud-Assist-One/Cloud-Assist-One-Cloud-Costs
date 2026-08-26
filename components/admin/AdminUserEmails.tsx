'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Company, Profile } from '@/lib/types';
import styles from './AdminUserEmails.module.css';

/**
 * The list of every email address that can sign in to the portal, with the
 * ability to revoke one.
 *
 * Split out of AdminUsers so creating access and revoking it are separate
 * screens: the two are done at different times, and a delete button sitting
 * under a form invites mis-clicks.
 *
 * Deleting is open to staff as well as admins, matching what the DELETE route
 * already allows -- the route, not this component, is the real guard.
 */
export default function AdminUserEmails() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    const response = await fetch('/api/admin/users');
    const body = await response.json();
    return (body.users ?? []) as Profile[];
  }, []);

  const fetchCompanies = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
    return (data ?? []) as Company[];
  }, []);

  const loadUsers = useCallback(async () => {
    const userList = await fetchUsers();
    setUsers(userList);
    setLoading(false);
  }, [fetchUsers]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [userList, companyList] = await Promise.all([fetchUsers(), fetchCompanies()]);
      if (!cancelled) {
        setUsers(userList);
        setCompanies(companyList);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchUsers, fetchCompanies]);

  function companyName(id: string | null): string {
    if (!id) return '—';
    return companies.find((c) => c.id === id)?.name ?? id;
  }

  async function handleDelete(user: Profile) {
    // review_notes.author_id, review_todos.created_by, and time_entries.staff_id
    // all cascade from profiles, so the delete takes billing-relevant data with it.
    const confirmed = window.confirm(
      `Delete ${user.email}? This permanently deletes their account and ALL notes, follow-ups, ` +
        `and logged time entries they created across every company. This cannot be undone.`
    );
    if (!confirmed) return;
    setError(null);
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Could not delete the user.');
      return;
    }
    loadUsers();
  }

  return (
    <div className={styles.wrapper}>
      <h3>Email Management</h3>
      <p className={styles.intro}>
        Every email address that can sign in to the portal. Deleting one revokes that person&apos;s access.
      </p>

      <div className={styles.toolbar}>
        <button type="button" className={styles.refreshButton} onClick={loadUsers}>
          Refresh
        </button>
      </div>

      {error && <p role="alert">{error}</p>}

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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{companyName(u.company_id)}</td>
                <td>
                  <button type="button" className={styles.deleteButton} onClick={() => handleDelete(u)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
