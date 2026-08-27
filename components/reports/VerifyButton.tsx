'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// The menu's own box, used to decide whether it fits below the button before
// it has been measured. Kept in step with .menu in the stylesheet.
const MENU_WIDTH = 160;
const MENU_HEIGHT = 84;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
}

// The grids put their tables in an overflow-x: auto container, which clips
// and scrolls absolutely-positioned descendants. Anchoring to the viewport
// instead — and rendering through a portal — is what lets the menu escape it,
// along with the section card's border-radius.
function positionFor(rect: DOMRect, viewportWidth: number, viewportHeight: number): MenuPosition {
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - MENU_WIDTH, viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN));

  // A row near the bottom of the window would otherwise open a menu that runs
  // off the page, so it opens upward instead.
  const fitsBelow = rect.bottom + GAP + MENU_HEIGHT + VIEWPORT_MARGIN <= viewportHeight;
  if (fitsBelow) return { left, top: rect.bottom + GAP };
  return { left, bottom: Math.max(VIEWPORT_MARGIN, viewportHeight - rect.top + GAP) };
}

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
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = position !== null;
  const close = useCallback(() => setPosition(null), []);

  function toggle() {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(positionFor(rect, window.innerWidth, window.innerHeight));
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      // The menu is portalled out of the wrapper, so it is no longer a DOM
      // descendant — without this second check, using the menu would dismiss it.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    }
    // A viewport-anchored menu does not follow its button, so it closes rather
    // than being left stranded beside the wrong row. Captured, so scrolling an
    // inner container counts too.
    function onScroll() {
      close();
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  async function fileTicket() {
    close();
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
    <div className={styles.wrapper}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.verifyButton}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={status === 'sending'}
        onClick={toggle}
      >
        <InfoIcon />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            style={{
              position: 'fixed',
              left: position.left,
              ...(position.top !== undefined ? { top: position.top } : {}),
              ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
            }}
          >
            <a role="menuitem" className={styles.menuItem} href={href} onClick={close}>
              Email
            </a>
            <button type="button" role="menuitem" className={styles.menuItem} onClick={fileTicket}>
              Support ticket
            </button>
          </div>,
          document.body
        )}

      {status === 'failed' && error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
