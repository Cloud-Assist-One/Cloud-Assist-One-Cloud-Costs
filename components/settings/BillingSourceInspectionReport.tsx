'use client';

import { summariseInspection } from '@/lib/billingSourceInspect';
import type { BillingSourceInspection } from '@/lib/types';
import styles from './BillingSourceInspectionReport.module.css';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface BillingSourceInspectionReportProps {
  inspection: BillingSourceInspection;
}

export default function BillingSourceInspectionReport({ inspection }: BillingSourceInspectionReportProps) {
  const verdict = summariseInspection(inspection);
  const { objects, objectCount, totalBytes, listingTruncated, runs, sample } = inspection;

  return (
    <div className={styles.report}>
      <div className={styles[verdict.tone]}>
        <p className={styles.headline}>{verdict.headline}</p>
        <p className={styles.detail}>{verdict.detail}</p>
      </div>

      {objectCount > 0 && (
        <details className={styles.section}>
          <summary>
            {objectCount} object(s), {formatBytes(totalBytes)}
            {listingTruncated ? ` — newest ${objects.length} shown` : ''}
          </summary>
          <ul className={styles.keyList}>
            {objects.map((object) => (
              <li key={object.key}>
                <span className={styles.mono}>{object.key}</span>
                <span className={styles.muted}>
                  {formatBytes(object.size)}
                  {object.lastModified ? ` · ${new Date(object.lastModified).toLocaleDateString()}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {runs.length > 0 && (
        <details className={styles.section}>
          <summary>{runs.length} import run(s) a pull would work through</summary>
          <ul className={styles.keyList}>
            {runs.map((run) => (
              <li key={run.key}>
                <span className={styles.mono}>{run.key}</span>
                <span className={styles.muted}>
                  {/* A run with no month is dated from its contents at pull time. */}
                  {run.month ?? 'month from contents'} · {run.partCount} part(s) · {formatBytes(run.totalBytes)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {sample && (
        <>
          <details className={styles.section} open={sample.missingRequired.length > 0}>
            <summary>Header row of {sample.key}</summary>
            <p className={`${styles.headerRow} ${styles.mono}`}>{sample.headers.join(', ') || '(no header row)'}</p>
          </details>

          <details className={styles.section}>
            <summary>
              Columns resolved ({sample.columns.filter((column) => column.header !== null).length} of{' '}
              {sample.columns.length})
            </summary>
            <table className={styles.columnTable}>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Header in this file</th>
                </tr>
              </thead>
              <tbody>
                {sample.columns.map((column) => (
                  <tr key={column.field}>
                    <th scope="row">
                      {column.label}
                      {column.required ? ' *' : ''}
                    </th>
                    <td className={column.header ? styles.mono : styles.unmatched}>
                      {column.header ?? 'not in this file'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sample.tagColumns.length > 0 && <p className={styles.detail}>Tags: {sample.tagColumns.join(', ')}</p>}
          </details>
        </>
      )}
    </div>
  );
}
