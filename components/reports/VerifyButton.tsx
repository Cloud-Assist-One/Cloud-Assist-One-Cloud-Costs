'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupportTopic } from '@/lib/supportTopics';
import styles from './VerifyButton.module.css';

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="8" y1="7.25" x2="8" y2="11.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="4.75" r="0.9" fill="currentColor" />
    </svg>
  );
}

export interface VerifyTicket {
  companyId: string;
  topic: SupportTopic;
  details: string;
}

type Status = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The per-row "ask someone about this" action, shared by the resource grids
 * and the findings grids so the icon and its behaviour cannot drift apart.
 *
 * Two ways to ask: an email the user sends themselves, or a support ticket
 * filed into the Cloud Assist queue. Both carry the same text — the caller
 * builds it once via lib/verifyEmail.
 */
export default function VerifyButton({
  href,
  label,
  ticket,
}: {
  href: string;
  label: string;
  ticket: VerifyTicket;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close();
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  async function fileTicket() {
    setOpen(false);
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/support-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: ticket.companyId,
          topics: [ticket.topic],
          details: ticket.details,
          // Tells the route this came from a grid row, so the submitter is
          // read from the session instead of from a form.
          origin: 'portal',
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not raise the support ticket.');
      setStatus('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not raise the support ticket.');
      setStatus('failed');
    }
  }

  // Once a ticket exists there is nothing left to ask, and the queue has no
  // dedup — so the control is replaced by its own confirmation rather than
  // left clickable.
  if (status === 'sent') {
    return <span className={styles.sent}>Ticket sent</span>;
  }

  return (
    <div className={styles.wrapper} ref={containerRef}>
      <button
        type="button"
        className={styles.verifyButton}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={status === 'sending'}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <InfoIcon />
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <a role="menuitem" className={styles.menuItem} href={href} onClick={close}>
            Email
          </a>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={fileTicket}>
            Support ticket
          </button>
        </div>
      )}

      {status === 'failed' && error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
