'use client';

import { useEffect, useState } from 'react';
import { formatBillingMonth } from '@/lib/cloudProvider';
import { sourcesForProvider } from '@/lib/billingSourceAvailability';
import type { BillingSourcePullResult, BillingSourcePullRun, CloudProvider } from '@/lib/types';
import styles from './PullBillingFromBucketModal.module.css';

// Only the fields this modal needs from a configured bucket source.
interface SourceOption {
  id: string;
  label: string;
  container: string;
  prefix: string;
  cloud_provider: string;
  enabled?: boolean | null;
}

interface PullBillingFromBucketModalProps {
  companyId: string;
  /** The tab's cloud. The API returns every source for the company. */
  provider: CloudProvider;
  onClose: () => void;
  onPulled: () => void;
}

type Step = 'loading' | 'empty' | 'picker' | 'confirm' | 'result';

// Runs come back in whatever order the pull discovered them; grouping by
// month (in first-seen order) is what makes the report readable rather than
// a flat, unsorted list of keys.
function groupRunsByMonth(runs: BillingSourcePullRun[]): [string | null, BillingSourcePullRun[]][] {
  const order: (string | null)[] = [];
  const groups = new Map<string | null, BillingSourcePullRun[]>();
  for (const run of runs) {
    if (!groups.has(run.month)) {
      groups.set(run.month, []);
      order.push(run.month);
    }
    groups.get(run.month)!.push(run);
  }
  return order.map((month) => [month, groups.get(month) ?? []]);
}

export default function PullBillingFromBucketModal({ companyId, provider, onClose, onPulled }: PullBillingFromBucketModalProps) {
  const [sources, setSources] = useState<SourceOption[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [step, setStep] = useState<Step>('loading');
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<BillingSourcePullResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSources() {
      try {
        const response = await fetch(`/api/settings/billing-file-sources?companyId=${companyId}`);
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setSourcesError(body.error ?? 'Could not load your configured buckets.');
          setStep('empty');
          return;
        }
        // Scoped to the tab's own cloud: the endpoint returns every source
        // the company has, and offering an S3 bucket on the Azure tab would
        // pull the wrong provider's billing into this period.
        const list = sourcesForProvider((body.sources ?? []) as SourceOption[], provider);
        setSources(list);
        if (list.length === 0) {
          setStep('empty');
        } else if (list.length === 1) {
          setSelectedSourceId(list[0].id);
          setStep('confirm');
        } else {
          setSelectedSourceId(list[0].id);
          setStep('picker');
        }
      } catch {
        if (!cancelled) {
          setSourcesError('Could not load your configured buckets.');
          setStep('empty');
        }
      }
    }

    loadSources();
    return () => {
      cancelled = true;
    };
  }, [companyId, provider]);

  async function handlePull() {
    setStep('result');
    setPulling(true);
    setPullError(null);
    try {
      const response = await fetch(`/api/billing-sources/${selectedSourceId}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, archiveFirst: true }),
      });
      const body = await response.json();
      if (!response.ok) {
        setPullError(body.error ?? 'Could not pull billing data.');
        setPulling(false);
        return;
      }
      setPullResult(body as BillingSourcePullResult);
      setPulling(false);
      // Fire as soon as the pull succeeds, like PullBillingModal does, so the
      // report behind the modal reloads without waiting for "Done".
      onPulled();
    } catch {
      setPullError('Could not pull billing data. Please check your connection and try again.');
      setPulling(false);
    }
  }

  const selectedSource = sources?.find((s) => s.id === selectedSourceId) ?? null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Detail Pull">
      <div className={styles.dialog}>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ×
        </button>

        {step === 'loading' && !sourcesError && <p>Loading your configured buckets…</p>}

        {sourcesError && (
          <p role="alert" className={styles.error}>
            {sourcesError}
          </p>
        )}

        {step === 'empty' && !sourcesError && (
          <p>No buckets configured yet. Add one in Settings first.</p>
        )}

        {step === 'picker' && sources && (
          <div className={styles.form}>
            <label htmlFor="pull-billing-bucket-source">Bucket</label>
            <select
              id="pull-billing-bucket-source"
              value={selectedSourceId}
              onChange={(e) => setSelectedSourceId(e.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
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

        {step === 'confirm' && selectedSource && (
          <div className={styles.confirm}>
            <h3>Detail Pull from {selectedSource.label}</h3>
            <p>
              If this bucket&apos;s newest month is the one already in the current period, it is imported alongside
              what is there — pulling your other cloud does not displace this one.
            </p>
            <p>
              A newer month archives the current period first, both clouds together, and the archived copy stays
              readable under the Archive tab. If an archive already exists for that month, it is replaced.
            </p>
            <p>
              Importing into an archived period that already exists for its month overwrites that provider&apos;s
              rows in the file&apos;s date range, rather than adding to them.
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={handlePull}>
                OK
              </button>
            </div>
          </div>
        )}

        {step === 'result' && (
          <div className={styles.result}>
            {pulling ? (
              <p>Pulling billing data…</p>
            ) : pullError ? (
              <>
                <p role="alert" className={styles.error}>
                  {pullError}
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
            ) : pullResult ? (
              <>
                <p className={styles.summary}>
                  Imported {pullResult.imported}, skipped {pullResult.skipped}, failed {pullResult.failed}.
                </p>
                {groupRunsByMonth(pullResult.runs).map(([month, monthRuns]) => (
                  <div key={month ?? 'unrecognised'} className={styles.monthGroup}>
                    <h4>{month ? formatBillingMonth(month) : 'Unrecognised files'}</h4>
                    <ul>
                      {monthRuns.map((run) => (
                        <li key={run.key}>
                          {run.status === 'imported' ? (
                            <span>
                              Imported into the {run.periodKind} period — {run.rowCount} rows.
                            </span>
                          ) : (
                            <span>
                              {run.status === 'skipped' ? 'Skipped: ' : 'Failed: '}
                              {run.reason}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div className={styles.actions}>
                  <button type="button" onClick={onClose}>
                    Done
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
