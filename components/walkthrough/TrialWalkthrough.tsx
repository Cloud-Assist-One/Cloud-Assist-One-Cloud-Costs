'use client';

import { useEffect, useState } from 'react';
import WalkthroughModal from './WalkthroughModal';

/** Marks that this browser session has already been shown the tour. */
const SESSION_KEY = 'cao-walkthrough-shown';

/**
 * Opens the trial walkthrough once per browser session.
 *
 * "Once per session" rather than literally once per login: Next.js gives us no
 * login event to hang this on, and a Supabase session can outlive many page
 * loads. Keying on sessionStorage means signing out and back in -- or opening
 * a new tab tomorrow -- brings the tour back, while an F5 mid-task does not.
 *
 * The server decides *whether* this component renders at all (client role, in
 * trial, not permanently dismissed). This component only decides *when*.
 */
export default function TrialWalkthrough() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY) === '1') return;
      sessionStorage.setItem(SESSION_KEY, '1');
      setOpen(true);
    } catch {
      // Private browsing and some embedded webviews throw on sessionStorage.
      // Showing the tour is the friendlier failure: worst case it reappears on
      // a later load, which is exactly what it would do anyway for a user who
      // has not dismissed it.
      setOpen(true);
    }
  }, []);

  if (!open) return null;

  return (
    <WalkthroughModal
      onClose={async (remember) => {
        // Close first. The tour is finished either way, and leaving a modal up
        // while a preference saves would make a slow network look like a hang.
        setOpen(false);

        if (!remember) return;

        try {
          await fetch('/api/walkthrough/dismiss', { method: 'POST' });
        } catch {
          // A failed save is self-correcting: the tour simply returns next
          // session and they can tick the box again. Blocking a finished
          // walkthrough on a preference write would be the worse trade.
        }
      }}
    />
  );
}
