'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PAID_SUBSCRIPTION_TIERS } from '@/lib/stripePricing';
import type { PaidSubscriptionTier } from '@/lib/stripePricing';
import { connectionLimitFor, isSubscriptionTier, SUBSCRIPTION_TIER_LABELS } from '@/lib/subscriptionTiers';
import type { Company } from '@/lib/types';
import styles from './BillingPanel.module.css';

interface BillingPanelProps {
  companyId: string;
}

// Cosmetic only -- nothing here decides who has access to what, that stays
// in resolveSubscriptionEvent. An unrecognised status (a future Stripe API
// addition) falls back to showing its own raw value rather than hiding it.
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment past due',
  unpaid: 'Payment failed',
  canceled: 'Canceled',
  incomplete: 'Awaiting payment',
  incomplete_expired: 'Payment never completed',
  paused: 'Paused',
};

function statusLabel(status: string | null): string | null {
  if (!status) return null;
  return STATUS_LABELS[status] ?? status;
}

function connectionsDescription(tier: string): string {
  // connectionLimitFor, not a direct CONNECTION_LIMITS lookup with a ??
  // fallback: the unlimited tier's own limit IS null, and ?? treats null as
  // absent, which silently fell back to the free tier's limit of 1 for the
  // one plan that is supposed to say "unlimited".
  const limit = connectionLimitFor(tier);
  if (limit === null) return 'Unlimited cloud connections';
  return `${limit} cloud connection${limit === 1 ? '' : 's'}`;
}

type Banner = { tone: 'success' | 'info'; text: string };

const BANNER_FOR_QUERY: Record<string, Banner> = {
  success: { tone: 'success', text: 'Subscription started. It may take a few seconds to appear below.' },
  cancelled: { tone: 'info', text: 'Checkout was cancelled -- no charge was made.' },
  portal: { tone: 'info', text: 'Welcome back. Refresh below if a change you just made is not showing yet.' },
};

export default function BillingPanel({ companyId }: BillingPanelProps) {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A lazy initializer, not a mount effect: reading the query string here
  // needs no extra render pass, and -- unlike AppShell's own initial tab --
  // this component is only ever mounted client-side after a tab switch, so
  // there is no server-rendered version of it for a browser-only read to
  // disagree with.
  const [banner] = useState<Banner | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get('billing');
    const found = billingParam ? BANNER_FOR_QUERY[billingParam] : undefined;
    if (!found) return null;

    // Stripped right away, in the same pass -- a page refresh right after
    // landing back must not keep re-showing this banner for the rest of the
    // session.
    params.delete('billing');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    return found;
  });
  // Which action is in flight, so only the button that was clicked shows a
  // busy state rather than graying out every button on the page.
  const [pendingAction, setPendingAction] = useState<PaidSubscriptionTier | 'portal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Checkout and the billing portal are both Stripe-hosted pages, so the end
  // of either action is a full navigation away from this component -- never
  // set directly from the click handler (only an effect may mutate
  // window.location here), only recorded, and this effect below carries it
  // out.
  const [redirectTo, setRedirectTo] = useState<string | null>(null);

  const fetchCompany = useCallback(async () => {
    const supabase = createClient();
    return supabase.from('companies').select('*').eq('id', companyId).maybeSingle();
  }, [companyId]);

  // Used by the Refresh button: a manually triggered reload with no
  // in-flight request to race against a possible unmount, same as the
  // refresh buttons elsewhere in this codebase (e.g. AdminUserEmails).
  const loadCompany = useCallback(async () => {
    setLoadError(null);
    const { data, error } = await fetchCompany();
    if (error || !data) {
      setLoadError('Could not load billing information.');
    } else {
      setCompany(data as Company);
    }
    setLoading(false);
  }, [fetchCompany]);

  useEffect(() => {
    if (redirectTo) {
      window.location.href = redirectTo;
    }
  }, [redirectTo]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await fetchCompany();
      if (cancelled) return;
      if (error || !data) {
        setLoadError('Could not load billing information.');
      } else {
        setCompany(data as Company);
      }
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fetchCompany]);

  async function startCheckout(tier: PaidSubscriptionTier) {
    setActionError(null);
    setPendingAction(tier);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, tier }),
      });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body.error ?? 'Could not start checkout.');
        setPendingAction(null);
        return;
      }
      setRedirectTo(body.url);
    } catch {
      setActionError('Could not start checkout. Please try again.');
      setPendingAction(null);
    }
  }

  async function openPortal() {
    setActionError(null);
    setPendingAction('portal');
    try {
      const response = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      const body = await response.json();
      if (!response.ok) {
        setActionError(body.error ?? 'Could not open billing management.');
        setPendingAction(null);
        return;
      }
      setRedirectTo(body.url);
    } catch {
      setActionError('Could not open billing management. Please try again.');
      setPendingAction(null);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (loadError || !company) return <p role="alert">{loadError ?? 'Could not load billing information.'}</p>;

  const tier = isSubscriptionTier(company.subscription_tier) ? company.subscription_tier : 'free';
  const onPaidTier = tier !== 'free';
  const status = statusLabel(company.subscription_status);

  return (
    <div className={styles.wrapper}>
      <h3>Billing</h3>

      {banner && <p className={`${styles.banner} ${styles[banner.tone]}`}>{banner.text}</p>}
      {actionError && (
        <p role="alert" className={styles.error}>
          {actionError}
        </p>
      )}

      <div className={styles.currentPlan}>
        <div>
          <span className={styles.currentPlanLabel}>Current plan</span>
          <strong>{SUBSCRIPTION_TIER_LABELS[tier]}</strong>
          <span className={styles.muted}>{connectionsDescription(tier)}</span>
        </div>
        {status && <span className={styles.statusBadge}>{status}</span>}
        <button type="button" className={styles.refreshButton} onClick={loadCompany}>
          Refresh
        </button>
      </div>

      {company.stripe_customer_id && (
        <div className={styles.manage}>
          <p>Change plans, update your card, view invoices, or cancel -- all through Stripe.</p>
          <button type="button" disabled={pendingAction !== null} onClick={openPortal}>
            {pendingAction === 'portal' ? 'Opening…' : 'Manage billing'}
          </button>
        </div>
      )}

      {!onPaidTier && (
        <div className={styles.plans}>
          {PAID_SUBSCRIPTION_TIERS.map((paidTier) => (
            <div key={paidTier} className={styles.planCard}>
              <strong>{SUBSCRIPTION_TIER_LABELS[paidTier]}</strong>
              <span className={styles.muted}>{connectionsDescription(paidTier)}</span>
              <button type="button" disabled={pendingAction !== null} onClick={() => startCheckout(paidTier)}>
                {pendingAction === paidTier ? 'Starting…' : 'Subscribe'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
