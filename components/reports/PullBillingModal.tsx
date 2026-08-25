'use client';

import { useEffect, useState } from 'react';
import type { AwsCredentialSummary } from '@/lib/types';
import { formatBillingMonth } from '@/lib/cloudProvider';
import styles from './PullBillingModal.module.css';

interface PullBillingModalProps {
  companyId: string;
  onClose: () => void;
  onPulled: (result: { rowCount: number; newPeriodId?: string }) => void;
}

type Step = 'form' | 'confirm' | 'result';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildPullableMonthOptions(now: Date): { label: string; value: string }[] {
  const year = now.getUTCFullYear();
  const currentMonthIndex0 = now.getUTCMonth();
  return MONTH_NAMES.slice(0, currentMonthIndex0 + 1).map((name, i) => ({
    label: `${name} ${year}`,
    value: `${year}-${String(i + 1).padStart(2, '0')}-01`,
  }));
}

export default function PullBillingModal({ companyId, onClose, onPulled }: PullBillingModalProps) {
  const monthOptions = buildPullableMonthOptions(new Date());

  const [connections, setConnections] = useState<AwsCredentialSummary[] | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [billingMonth, setBillingMonth] = useState(monthOptions[monthOptions.length - 1].value);
  const [step, setStep] = useState<Step>('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [newPeriodId, setNewPeriodId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function loadConnections() {
      try {
        const res = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
        const body = await res.json();
        if (cancelled) return;
        const list = (body.connections ?? []) as AwsCredentialSummary[];
        setConnections(list);
        if (list.length > 0) setSelectedCredentialId(list[0].id);
      } catch {
        if (!cancelled) setConnectionsError('Could not load your AWS connections.');
      }
    }

    loadConnections();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function submitPull(archiveFirst: boolean) {
    setStep('result');
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/aws/pull-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, credentialId: selectedCredentialId, billingMonth, archiveFirst }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSubmitError(body.error ?? 'Could not pull billing data.');
        setSubmitting(false);
        return;
      }
      setRowCount(body.rowCount);
      setNewPeriodId(body.newPeriodId);
      setSubmitting(false);
    } catch {
      setSubmitError('Could not pull billing data. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Pull AWS Billing">
      <div className={styles.dialog}>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ×
        </button>

        {connections === null && !connectionsError && <p>Loading your AWS connections…</p>}

        {connectionsError && (
          <p role="alert" className={styles.error}>
            {connectionsError}
          </p>
        )}

        {connections !== null && connections.length === 0 && (
          <p>No AWS connection found. Add one in the Settings tab first.</p>
        )}

        {connections !== null && connections.length > 0 && step === 'form' && (
          <div className={styles.form}>
            <h3>Pull Billing from AWS</h3>

            <label htmlFor="pull-billing-month">Billing month</label>
            <select id="pull-billing-month" value={billingMonth} onChange={(e) => setBillingMonth(e.target.value)}>
              {monthOptions.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>

            {connections.length > 1 && (
              <>
                <label htmlFor="pull-billing-account">Account</label>
                <select
                  id="pull-billing-account"
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </>
            )}

            <p>This will overwrite the current AWS Billing Overview data for the selected month.</p>

            <div className={styles.actions}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={() => setStep('confirm')}>
                Next
              </button>
            </div>
          </div>
        )}

        {connections !== null && connections.length > 0 && step === 'confirm' && (
          <div className={styles.confirm}>
            <p>This will overwrite the current AWS Billing Overview data for {formatBillingMonth(billingMonth)}.</p>
            <div className={styles.actions}>
              <button type="button" onClick={() => setStep('form')}>
                Back
              </button>
              <button type="button" onClick={() => submitPull(false)}>
                Ok
              </button>
              <button type="button" onClick={() => submitPull(true)}>
                Yes, but Archive Current View
              </button>
            </div>
          </div>
        )}

        {step === 'result' && (
          <div className={styles.result}>
            {submitting ? (
              <p>Pulling billing data…</p>
            ) : submitError ? (
              <>
                <p role="alert" className={styles.error}>
                  {submitError}
                </p>
                <div className={styles.actions}>
                  <button type="button" onClick={() => setStep('confirm')}>
                    Try Again
                  </button>
                  <button type="button" onClick={onClose}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p role="status">Pulled {rowCount} rows.</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() => {
                      onPulled({ rowCount: rowCount ?? 0, newPeriodId });
                      onClose();
                    }}
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
