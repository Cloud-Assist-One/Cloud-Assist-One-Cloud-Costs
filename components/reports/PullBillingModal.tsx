'use client';

import { useEffect, useState } from 'react';
import { formatBillingMonth, buildMonthOptions, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import styles from './PullBillingModal.module.css';

// Only the fields this modal actually needs — the provider-specific credential
// summary types (AwsCredentialSummary, AzureCredentialSummary) both satisfy it.
interface ConnectionOption {
  id: string;
  label: string;
}

type PullableProvider = 'aws' | 'azure';

interface PullBillingModalProps {
  companyId: string;
  provider: PullableProvider;
  onClose: () => void;
  onPulled: (result: { rowCount: number; newPeriodId?: string }) => void;
}

type Step = 'form' | 'confirm' | 'result';

// Pulling can only ever fetch data through the current calendar month, so
// slice the shared 12-month list down to months up to and including "now".
function buildPullableMonthOptions(now: Date): { label: string; value: string }[] {
  const currentMonthIndex0 = now.getUTCMonth();
  return buildMonthOptions(now).slice(0, currentMonthIndex0 + 1);
}

export default function PullBillingModal({ companyId, provider, onClose, onPulled }: PullBillingModalProps) {
  const monthOptions = buildPullableMonthOptions(new Date());
  const providerLabel = CLOUD_PROVIDER_LABELS[provider];

  const [connections, setConnections] = useState<ConnectionOption[] | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [billingMonth, setBillingMonth] = useState(monthOptions[monthOptions.length - 1].value);
  const [step, setStep] = useState<Step>('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  // Set when the pull worked but not as configured, e.g. AWS refused to group
  // by the connection's tag so no billing codes came back.
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadConnections() {
      try {
        const res = await fetch(`/api/settings/${provider}-credentials?companyId=${companyId}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setConnectionsError(body.error ?? `Could not load your ${providerLabel} connections.`);
          return;
        }
        const list = (body.connections ?? []) as ConnectionOption[];
        setConnections(list);
        if (list.length > 0) setSelectedCredentialId(list[0].id);
      } catch {
        if (!cancelled) setConnectionsError(`Could not load your ${providerLabel} connections.`);
      }
    }

    loadConnections();
    return () => {
      cancelled = true;
    };
  }, [companyId, provider, providerLabel]);

  async function submitPull(archiveFirst: boolean) {
    setStep('result');
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/${provider}/pull-billing`, {
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
      setWarning(body.warning ?? null);
      setSubmitting(false);
      // Fire onPulled here, right as the pull succeeds, rather than waiting
      // for the "Done" button: the × close button also renders on this step,
      // and if a user closes with × after an archiving pull, AppShell must
      // still learn about the new period so it stops pointing at the one
      // that was just archived. Use the response body directly since state
      // set above isn't visible synchronously.
      onPulled({ rowCount: body.rowCount, newPeriodId: body.newPeriodId });
    } catch {
      setSubmitError('Could not pull billing data. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Pull ${providerLabel} Billing`}>
      <div className={styles.dialog}>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ×
        </button>

        {connections === null && !connectionsError && <p>Loading your {providerLabel} connections…</p>}

        {connectionsError && (
          <p role="alert" className={styles.error}>
            {connectionsError}
          </p>
        )}

        {connections !== null && connections.length === 0 && (
          <p>No {providerLabel} connection found. Add one in the Settings tab first.</p>
        )}

        {connections !== null && connections.length > 0 && step === 'form' && (
          <div className={styles.form}>
            <h3>Quick Pull from {providerLabel}</h3>

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

            <p>
              This will overwrite the current {providerLabel} Billing Overview data for the selected month (through
              today).
            </p>

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
            <p>
              This will overwrite the current {providerLabel} Billing Overview data for{' '}
              {formatBillingMonth(billingMonth)} (through today).
            </p>
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
                {warning && <p role="alert">{warning}</p>}
                <div className={styles.actions}>
                  <button type="button" onClick={onClose}>
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
