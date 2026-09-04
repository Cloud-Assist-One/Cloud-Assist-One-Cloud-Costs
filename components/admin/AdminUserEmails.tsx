'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { describeAccountStatus } from '@/lib/adminUserActivity';
import type { AdminUserRow } from '@/lib/adminUserActivity';
import type { Company } from '@/lib/types';
import styles from './AdminUserEmails.module.css';

/**
 * A timestamp as an admin reads it: the date alone for a signup, date and
 * time for a sign-in, where "this morning or last week" is the question.
 * Null renders as an em dash rather than "Invalid Date".
 */
function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

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
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    const response = await fetch('/api/admin/users');
    const body = await response.json();
    return (body.users ?? []) as AdminUserRow[];
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

  async function handleDelete(user: AdminUserRow) {
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
      <p className={styles.intro}>
        A free sign-up is created unconfirmed and emailed a magic link; using that link both confirms the address
        and signs them in, so <strong>Link not used yet</strong> means the sign-up never completed. Accounts created
        from the Users form above are confirmed outright and never receive a link.
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
              <th>Signed up</th>
              <th>Status</th>
              <th>Email confirmed</th>
              <th>Last signed in</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const status = describeAccountStatus(u);
              return (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td>{companyName(u.company_id)}</td>
                  <td>{formatDate(u.created_at)}</td>
                  <td>
                    <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
                  </td>
                  <td>{u.email_confirmed_at ? formatDateTime(u.email_confirmed_at) : 'Not confirmed'}</td>
                  <td>{formatDateTime(u.last_sign_in_at)}</td>
                  <td>
                    <button type="button" className={styles.deleteButton} onClick={() => handleDelete(u)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
