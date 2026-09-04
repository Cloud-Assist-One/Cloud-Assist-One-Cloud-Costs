import type { CompanyAccess } from '@/lib/companyAccess';

// Urgency rises as the trial runs out, so a customer feels the deadline
// approaching while there's still time to route a card through finance:
// neutral above a week, warning inside a week, urgent in the final three
// days and on a failed payment. Tokens (app/globals.css), not literal
// Tailwind colors, so dark mode stays correct.
const TONE_CLASSES: Record<'neutral' | 'warning' | 'urgent', string> = {
  neutral: 'bg-muted text-foreground',
  warning: 'bg-warning text-warning-foreground',
  urgent: 'bg-destructive text-destructive-foreground',
};
const WARNING_DAYS_LEFT = 7;
const URGENT_DAYS_LEFT = 3;

function toneFor(daysLeft: number): 'neutral' | 'warning' | 'urgent' {
  if (daysLeft <= URGENT_DAYS_LEFT) return 'urgent';
  if (daysLeft <= WARNING_DAYS_LEFT) return 'warning';
  return 'neutral';
}

export default function TrialBanner({ access }: { access: CompanyAccess }) {
  if (access.state === 'active' || access.state === 'exempt') return null;

  if (access.state === 'past_due') {
    return (
      <div
        data-tone="urgent"
        className={`flex items-center justify-between gap-4 px-4 py-2 ${TONE_CLASSES.urgent}`}
      >
        <span>Payment failed. Update your card to avoid losing access.</span>
        <a href="/billing" className="underline font-medium">
          Update payment method
        </a>
      </div>
    );
  }

  if (access.state === 'trial_expired') {
    return (
      <div
        data-tone="urgent"
        className={`flex items-center justify-between gap-4 px-4 py-2 ${TONE_CLASSES.urgent}`}
      >
        <span>Your free trial has ended.</span>
        <a href="/billing" className="underline font-medium">
          Add payment method
        </a>
      </div>
    );
  }

  const { daysLeft } = access;
  const unit = daysLeft === 1 ? 'day' : 'days';
  const tone = toneFor(daysLeft);

  return (
    <div data-tone={tone} className={`flex items-center justify-between gap-4 px-4 py-2 ${TONE_CLASSES[tone]}`}>
      <span>
        {daysLeft} {unit} left in your free trial.
      </span>
      <a href="/billing" className="underline font-medium">
        Add payment method
      </a>
    </div>
  );
}
