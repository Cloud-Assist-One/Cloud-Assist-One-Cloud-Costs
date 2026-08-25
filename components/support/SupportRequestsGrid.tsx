'use client';

import type { SupportRequest, SupportRequestWithCompany } from '@/lib/types';
import styles from './Support.module.css';

interface SupportRequestsGridProps {
  requests: (SupportRequest | SupportRequestWithCompany)[];
  /** Admin view spans every client, so it gains a Company column. */
  showCompany?: boolean;
  emptyLabel: string;
}

function formatSubmitted(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatPhone(request: SupportRequest): string {
  if (!request.phone) return '—';
  return request.phone_ext ? `${request.phone} ext. ${request.phone_ext}` : request.phone;
}

export default function SupportRequestsGrid({ requests, showCompany, emptyLabel }: SupportRequestsGridProps) {
  if (requests.length === 0) {
    return <p>{emptyLabel}</p>;
  }

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Submitted</th>
            {showCompany && <th>Company</th>}
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Topics</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>{formatSubmitted(request.created_at)}</td>
              {showCompany && <td>{(request as SupportRequestWithCompany).company_name}</td>}
              <td>{request.first_name}</td>
              <td>{request.email}</td>
              <td>{formatPhone(request)}</td>
              <td>{request.topics.join(', ')}</td>
              <td>{request.details ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
