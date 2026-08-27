'use client';

import type { AwsResourceResult, CloudProvider } from '@/lib/types';
import { getResourceAgeColor } from '@/lib/resourceAge';
import { buildResourceVerifyMessage, resourceVerifyMailto, ticketTopicFor } from '@/lib/verifyEmail';
import VerifyButton from './VerifyButton';
import styles from './ResourceGrid.module.css';

const AGE_ROW_CLASS = {
  orange: styles.rowOrange,
  blue: styles.rowBlue,
  green: styles.rowGreen,
} as const;

export function ResourceLegend() {
  return (
    <div className={styles.legend}>
      <span className={`${styles.legendSwatch} ${styles.rowOrange}`} /> New in the last 24 hours
      <span className={`${styles.legendSwatch} ${styles.rowBlue}`} /> New in the last week
      <span className={`${styles.legendSwatch} ${styles.rowGreen}`} /> New in the last month
    </div>
  );
}

// The extra tag column is configured per AWS connection, so it is spread
// into each grid's column list rather than injected like Verify — a blank
// tagKey yields no column at all.
export function tagColumn<T extends { tagValue: string | null }>(
  tagKey: string
): { header: string; render: (row: T) => React.ReactNode }[] {
  if (!tagKey) return [];
  return [{ header: tagKey, render: (row: T) => row.tagValue ?? '—' }];
}

export function ResourceGrid<T extends object>({
  title,
  emptyLabel,
  result,
  columns,
  getCreatedAt,
  getName,
  resourceType,
  provider,
  companyId,
}: {
  title: string;
  emptyLabel: string;
  result: AwsResourceResult<T>;
  columns: { header: string; render: (row: T) => React.ReactNode; align?: 'right' }[];
  getCreatedAt: (row: T) => string | null;
  getName: (row: T) => string;
  resourceType: string;
  provider: CloudProvider;
  companyId: string;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>{title}</h3>
        {result.data.length > 0 && <span className={styles.countBadge}>{result.data.length}</span>}
      </div>
      {result.error && (
        <p role="alert" className={styles.error}>
          {result.error}
        </p>
      )}
      {result.data.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                {columns.map((col, index) => (
                  <th key={index} className={col.align === 'right' ? styles.numeric : undefined}>
                    {col.header}
                  </th>
                ))}
                <th className={styles.verifyCell}>Verify</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((row, index) => {
                const ageColor = getResourceAgeColor(getCreatedAt(row));
                const name = getName(row);
                return (
                  <tr key={index} className={ageColor ? AGE_ROW_CLASS[ageColor] : undefined}>
                    {columns.map((col, colIndex) => (
                      <td key={colIndex} className={col.align === 'right' ? styles.numeric : undefined}>
                        {col.render(row)}
                      </td>
                    ))}
                    <td className={styles.verifyCell}>
                      <VerifyButton
                        href={resourceVerifyMailto(provider, resourceType, name)}
                        label={`Verify this ${resourceType}, ${name}`}
                        ticket={{
                          companyId,
                          topic: ticketTopicFor('resource'),
                          details: buildResourceVerifyMessage(provider, resourceType, name).body,
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
