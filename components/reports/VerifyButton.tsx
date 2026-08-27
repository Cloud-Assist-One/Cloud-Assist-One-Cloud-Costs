'use client';

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

/**
 * The per-row "email someone about this" action, shared by the resource
 * grids and the findings grids so the icon and its styling cannot drift
 * apart between them. The href is built by the callers via lib/verifyEmail.
 */
export default function VerifyButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className={styles.verifyButton} aria-label={label} title={label}>
      <InfoIcon />
    </a>
  );
}
