'use client';

import type { CheckResult, CloudProvider, Finding, FindingSeverity } from '@/lib/types';
import { SEVERITY_ORDER } from '@/lib/findings';
import { buildFindingVerifyMessage, findingVerifyMailto, ticketTopicFor } from '@/lib/verifyEmail';
import VerifyButton from './VerifyButton';
import styles from './FindingsGrid.module.css';

const SEVERITY_CLASS: Record<FindingSeverity, string> = {
  critical: styles.critical,
  high: styles.high,
  medium: styles.medium,
  low: styles.low,
};

function formatCost(cost: number | null): string {
  // A resource missing from the last billing pull is unknown, not free.
  if (cost === null) return '—';
  return `$${cost.toFixed(2)}`;
}

// Leakage rows all share one severity, so ranking them by money is the only
// ordering that tells the customer anything. Unknown costs sort last: they
// are the rows we can say the least about.
function byCostDescending(a: Finding, b: Finding): number {
  if (a.monthlyCost === null && b.monthlyCost === null) return 0;
  if (a.monthlyCost === null) return 1;
  if (b.monthlyCost === null) return -1;
  return b.monthlyCost - a.monthlyCost;
}

// A section's rank is its most severe finding -- a section with one
// critical and nine lows still belongs at the top. A check that could not
// run ranks ahead of everything: it is the most actionable thing on the
// page, since the customer cannot even tell whether it would have found a
// problem. A check that ran clean (no findings at all) has no severity to
// rank by, so it sorts after every section that found something.
function sectionRank(check: CheckResult): number {
  if (check.status === 'unavailable') return -1;
  if (check.findings.length === 0) return Object.keys(SEVERITY_ORDER).length;
  return Math.min(...check.findings.map((finding) => SEVERITY_ORDER[finding.severity]));
}

function bySeverityRank(a: CheckResult, b: CheckResult): number {
  return sectionRank(a) - sectionRank(b);
}

export default function FindingsGrid({
  checks,
  kind,
  provider,
  companyId,
}: {
  checks: CheckResult[];
  kind: 'security-checks' | 'cost-leakage';
  provider: CloudProvider;
  companyId: string;
}) {
  const isLeakage = kind === 'cost-leakage';
  // Cost-leakage sections stay in the route's push order -- severity is not
  // meaningful there, every finding is 'low'. Security-checks sections are
  // reordered so the most severe (or least available) section leads.
  const orderedChecks = isLeakage ? checks : [...checks].sort(bySeverityRank);

  return (
    <div className={styles.sections}>
      {orderedChecks.map((check) => {
        const rows = isLeakage ? [...check.findings].sort(byCostDescending) : check.findings;

        return (
          <section key={check.checkId} className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>{check.title}</h3>
              <div className={styles.headerMeta}>
                {check.source === 'native' && (
                  <span className={styles.sourceBadge}>Security Hub / Defender</span>
                )}
                {rows.length > 0 && <span className={styles.countBadge}>{rows.length}</span>}
              </div>
            </div>

            {check.status === 'unavailable' ? (
              <p role="alert" className={styles.unavailable}>
                This check could not run: {check.unavailableReason}
              </p>
            ) : rows.length === 0 ? (
              <p className={styles.clean}>No findings.</p>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Region</th>
                      {isLeakage ? <th className={styles.numeric}>Monthly cost</th> : <th>Severity</th>}
                      <th>Detail</th>
                      <th className={styles.verifyCell}>Verify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${row.resourceId}-${index}`}>
                        <td>{row.resourceName}</td>
                        <td>{row.region ?? '—'}</td>
                        {isLeakage ? (
                          <td className={styles.numeric}>{formatCost(row.monthlyCost)}</td>
                        ) : (
                          <td>
                            <span className={`${styles.severity} ${SEVERITY_CLASS[row.severity]}`}>{row.severity}</span>
                          </td>
                        )}
                        <td className={styles.detailCell}>{row.detail}</td>
                        <td className={styles.verifyCell}>
                          <VerifyButton
                            href={findingVerifyMailto(provider, kind, check, row)}
                            label={`Verify this finding, ${row.resourceName}`}
                            ticket={{
                              companyId,
                              topic: ticketTopicFor(kind),
                              details: buildFindingVerifyMessage(provider, kind, check, row).body,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
