import type { CompanyAccess } from '@/lib/companyAccess';

// This app's token set (app/globals.css) has no dedicated "warning" color --
// only neutral (muted) and problem (destructive) semantics exist, matching
// how Badge/Button already split their variants. So urgency is binary: muted
// until the final stretch of the trial, destructive once payment is actually
// failing or the countdown is nearly out.
const NEUTRAL_TONE = 'bg-muted text-foreground';
const URGENT_TONE = 'bg-destructive text-destructive-foreground';
const URGENT_DAYS_LEFT = 3;

export default function TrialBanner({ access }: { access: CompanyAccess }) {
  if (access.state === 'active' || access.state === 'exempt') return null;

  if (access.state === 'past_due') {
    return (
      <div className={`flex items-center justify-between gap-4 px-4 py-2 ${URGENT_TONE}`}>
        <span>Payment failed. Update your card to avoid losing access.</span>
        <a href="/billing" className="underline font-medium">
          Update payment method
        </a>
      </div>
    );
  }

  if (access.state === 'trial_expired') {
    return (
      <div className={`flex items-center justify-between gap-4 px-4 py-2 ${URGENT_TONE}`}>
        <span>Your free trial has ended.</span>
        <a href="/billing" className="underline font-medium">
          Add payment method
        </a>
      </div>
    );
  }

  const { daysLeft } = access;
  const unit = daysLeft === 1 ? 'day' : 'days';
  const tone = daysLeft <= URGENT_DAYS_LEFT ? URGENT_TONE : NEUTRAL_TONE;

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 ${tone}`}>
      <span>
        {daysLeft} {unit} left in your free trial.
      </span>
      <a href="/billing" className="underline font-medium">
        Add payment method
      </a>
    </div>
  );
}
