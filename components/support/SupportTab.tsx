'use client';

import { FormEvent, useEffect, useState } from 'react';
import { SUPPORT_TOPICS } from '@/lib/supportTopics';
import type { SupportRequest } from '@/lib/types';
import SupportRequestsGrid from './SupportRequestsGrid';
import styles from './Support.module.css';

interface SupportTabProps {
  companyId: string;
  userEmail: string;
}

type Status = 'idle' | 'submitting';

export default function SupportTab({ companyId, userEmail }: SupportTabProps) {
  const [firstName, setFirstName] = useState('');
  // Pre-filled with the signed-in address but editable, so a request can name
  // a different contact without changing the account.
  const [email, setEmail] = useState(userEmail);
  const [phone, setPhone] = useState('');
  const [phoneExt, setPhoneExt] = useState('');
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [details, setDetails] = useState('');

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [requests, setRequests] = useState<SupportRequest[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Bumped after a successful submit so the history below reloads without a
  // page refresh.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadRequests() {
      try {
        const res = await fetch(`/api/support-requests?companyId=${companyId}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setListError(body.error ?? 'Could not load your support requests.');
          return;
        }
        setRequests(body.requests ?? []);
        setListError(null);
      } catch {
        if (!cancelled) setListError('Could not load your support requests.');
      }
    }

    loadRequests();
    return () => {
      cancelled = true;
    };
  }, [companyId, reloadToken]);

  function toggleTopic(topic: string) {
    setSelectedTopics((current) =>
      current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic]
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus('submitting');
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch('/api/support-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          firstName,
          email,
          phone,
          phoneExt,
          topics: selectedTopics,
          details,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not submit your request.');
        setStatus('idle');
        return;
      }

      setSuccessMessage('Thanks — your request has been submitted. We will be in touch.');
      setFirstName('');
      setPhone('');
      setPhoneExt('');
      setSelectedTopics([]);
      setDetails('');
      setStatus('idle');
      setReloadToken((token) => token + 1);
    } catch {
      setError('Could not submit your request. Please check your connection and try again.');
      setStatus('idle');
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.intro}>
        <h2>Need help reducing your cloud billing, tagging resources or cloud technical support?</h2>
        <p>Please contact us.</p>
      </div>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="support-first-name">First name</label>
            <input
              id="support-first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="support-email">Email</label>
            <input id="support-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="support-phone">Phone number</label>
            <input id="support-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>

          <div className={styles.fieldNarrow}>
            <label htmlFor="support-phone-ext">Ext.</label>
            <input id="support-phone-ext" value={phoneExt} onChange={(e) => setPhoneExt(e.target.value)} />
          </div>
        </div>

        <fieldset className={styles.topics}>
          <legend>What do you need help with?</legend>
          {SUPPORT_TOPICS.map((topic) => (
            <label key={topic} className={styles.checkboxRow}>
              <input type="checkbox" checked={selectedTopics.includes(topic)} onChange={() => toggleTopic(topic)} />
              <span>{topic}</span>
            </label>
          ))}
        </fieldset>

        <div className={styles.field}>
          <label htmlFor="support-details">Details (optional)</label>
          <textarea
            id="support-details"
            rows={4}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Anything else that would help us prepare"
          />
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {successMessage && (
          <p role="status" className={styles.success}>
            {successMessage}
          </p>
        )}

        <button type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Submitting…' : 'Submit request'}
        </button>
      </form>

      <section className={styles.history}>
        <h3>Your support requests</h3>
        {listError ? (
          <p role="alert" className={styles.error}>
            {listError}
          </p>
        ) : requests === null ? (
          <p>Loading…</p>
        ) : (
          <SupportRequestsGrid requests={requests} emptyLabel="No support requests submitted yet." />
        )}
      </section>
    </div>
  );
}
