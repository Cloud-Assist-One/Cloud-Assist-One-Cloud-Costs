'use client';

import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';
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

export default function FindingsGrid({
  checks,
  kind,
}: {
  checks: CheckResult[];
  kind: 'security-checks' | 'cost-leakage';
}) {
  const isLeakage = kind === 'cost-leakage';

  return (
    <div className={styles.sections}>
      {checks.map((check) => {
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
