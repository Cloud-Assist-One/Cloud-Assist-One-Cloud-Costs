'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WALKTHROUGH_STEPS } from '@/lib/walkthroughSteps';

interface WalkthroughModalProps {
  /** Called when the tour is closed, however it was closed. `remember` is true
   *  only when the user ticked "Don't show this again" on the final step. */
  onClose: (remember: boolean) => void;
}

export default function WalkthroughModal({ onClose }: WalkthroughModalProps) {
  const [index, setIndex] = useState(0);
  const [remember, setRemember] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const step = WALKTHROUGH_STEPS[index];
  const isLast = index === WALKTHROUGH_STEPS.length - 1;

  // `remember` is only offered on the final step, so a user who ticks the box
  // and then clicks Back must not silently carry the opt-out to an early exit.
  const close = (withRemember: boolean) => onClose(withRemember && isLast);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // `close` closes over isLast, but Escape always exits without remembering,
    // so the listener never needs rebinding as the step changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      // A click that starts and ends on the backdrop closes; one that merely
      // ends there after a drag from inside the panel does not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="walkthrough-title"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
      >
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <h2 id="walkthrough-title" className="text-lg font-semibold">
              {step.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Step {index + 1} of {WALKTHROUGH_STEPS.length}
            </p>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Close walkthrough"
            onClick={() => close(false)}
          >
            ✕
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* A plain img, not next/image: these are pre-sized screenshots of
              varying dimensions and lazy loading is all we need, so the extra
              config next/image would want buys nothing here. */}
          <img
            src={step.image}
            alt={step.title}
            loading="lazy"
            className="w-full rounded border"
          />
          <p className="mt-4 text-sm">{step.body}</p>
        </div>

        <div className="flex items-center justify-between gap-4 border-t px-6 py-4">
          <div className="text-sm">
            {isLast ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Don&apos;t show this again
              </label>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
            >
              Back
            </Button>
            {isLast ? (
              <Button type="button" onClick={() => close(remember)}>
                Done
              </Button>
            ) : (
              <Button type="button" onClick={() => setIndex((i) => i + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
