# Stripe Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give companies a visible 30-day trial that hard-locks on day 31, let them buy the $150/mo and $250/mo tiers by card, and invoice logged consulting hours through Stripe.

**Architecture:** Stripe is mirrored into `companies` columns by a webhook that is the single writer of Stripe state. All gating reads a pure function, `resolveCompanyAccess`, that turns a company row into one of five states. Reads never call Stripe, so pages stay fast and the app survives a Stripe outage.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` middleware), React 19, Supabase (Postgres + RLS + SSR auth), Stripe Node SDK, Jest 30 with `next/jest`.

**Spec:** `docs/superpowers/specs/2026-09-04-stripe-billing-design.md`

## Global Constraints

- ES modules, `async`/`await` over `.then()`, 2-space indent, descriptive names. Comment WHY, not WHAT.
- Never put secrets in code files. All four Stripe values come from `process.env`. `.env.local` is already gitignored.
- Money is **integer cents** everywhere. No floats, no dollar strings, in any calculation.
- Unrecognised or missing values resolve to the **most restrictive** outcome, matching `lib/subscriptionTiers.ts`.
- New pure helpers follow the shape of `lib/subscriptionTiers.ts`: no I/O, exported functions, colocated `.test.ts`.
- Route tests use the recording-fake pattern from `lib/connectionAllowance.test.ts`, not network mocks.
- Tests run with `npm test`. Every task ends green before its commit.
- Tier to price: `subscription_4` = $150/mo, `subscription_20` = $250/mo. `subscription_unlimited` has **no** Stripe price and is admin-granted only.
- Env var names, exactly: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SUB4`, `STRIPE_PRICE_SUB20`, `NEXT_PUBLIC_SITE_URL`. None of the
  four Stripe values carry a `NEXT_PUBLIC_` prefix -- nothing in the browser reads
  them. `NEXT_PUBLIC_SITE_URL` is the trusted origin for Stripe redirect URLs and
  must be preferred over the request's own origin, which is derived from the
  `Host` header and therefore attacker-influencable.

## Refinement from the spec, decided while planning

The spec places the hard lock in `app/layout.tsx`. During planning I read `app/page.tsx` and found it is already an async server component that fetches the user and their `profile.company_id`. Putting the lock there instead is strictly better:

- `RootLayout` wraps `/billing` too, so locking there risks a redirect loop.
- `app/page.tsx` already has `company_id` in hand, so the lock costs one extra query rather than a new auth path.
- The lock renders `<TrialExpired />` **in place of** `<AppShell />`. `AppShell` is what mounts every data tab, so nothing gated ever reaches the browser. This is a stronger guarantee than a redirect, which a client could in principle race.

`/billing` remains a real page for active customers to manage their card.

## File structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20260904000000_stripe_billing.sql` | Trial, Stripe columns, time-entry billing columns, `stripe_events` |
| `lib/companyAccess.ts` | Pure: company row to one of five access states |
| `lib/consultingRate.ts` | Pure: rate resolution and minutes-to-cents |
| `lib/stripe.ts` | Stripe client factory, tier to price id both ways |
| `lib/companyBilling.ts` | Fetch a company row and resolve its access (I/O) |
| `lib/billingGuard.ts` | `requireActiveBilling` for mutating API routes |
| `components/billing/TrialBanner.tsx` | Persistent countdown strip |
| `components/billing/TrialExpired.tsx` | The hard-lock screen |
| `app/billing/page.tsx` | Plan cards and Manage Billing |
| `app/api/billing/checkout/route.ts` | Creates a Checkout Session |
| `app/api/billing/portal/route.ts` | Opens the Stripe Billing Portal |
| `app/api/billing/webhook/route.ts` | The only writer of Stripe state |
| `app/api/billing/consulting/invoice/route.ts` | Invoices unbilled time entries |
| `components/admin/AdminConsulting.tsx` | Unbilled hours per company |

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260904000000_stripe_billing.sql`
- Modify: `.env.local.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `companies.trial_ends_at`, `companies.stripe_customer_id`, `companies.stripe_subscription_id`, `companies.subscription_status`, `companies.hourly_rate_cents`; `time_entries.billable`, `time_entries.rate_cents_at_invoice`, `time_entries.stripe_invoice_id`, `time_entries.invoiced_at`; table `stripe_events(id text primary key, processed_at timestamptz)`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260904000000_stripe_billing.sql`:

```sql
-- Stripe billing ---------------------------------------------------------
--
-- The trial is tracked here, not in Stripe: signup takes no card, so Stripe
-- learns about a company only when it pays. The four Stripe columns have
-- exactly one writer, the webhook handler running as the service role.

alter table public.companies
  add column trial_ends_at timestamptz default now() + interval '30 days',
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column subscription_status text
    check (subscription_status in
      ('trialing','active','past_due','canceled','incomplete'));

-- Existing free companies start their 30 days at deploy rather than at
-- signup, so shipping this locks nobody out on day one. Companies an admin
-- already placed on a paid tier keep a null trial and are never gated.
update public.companies
   set trial_ends_at = now() + interval '30 days'
 where subscription_tier = 'free';

-- null means "use DEFAULT_HOURLY_RATE_CENTS from lib/consultingRate.ts".
alter table public.companies
  add column hourly_rate_cents integer check (hourly_rate_cents >= 0);

-- rate_cents_at_invoice is copied on at invoice time so that raising the
-- rate later never rewrites what an old invoice said. A non-null
-- stripe_invoice_id is the "already billed" flag -- one source of truth, so
-- an entry cannot be billed twice.
alter table public.time_entries
  add column billable boolean not null default true,
  add column rate_cents_at_invoice integer,
  add column stripe_invoice_id text,
  add column invoiced_at timestamptz;

create index time_entries_unbilled_idx on public.time_entries (company_id)
  where stripe_invoice_id is null and billable;

-- Stripe can deliver an event more than once. Inserting the event id first
-- and treating a primary-key conflict as "already handled" makes double
-- processing structurally impossible.
create table public.stripe_events (
  id text primary key,
  processed_at timestamptz not null default now()
);

-- RLS on with no policies: only the service role touches this table.
alter table public.stripe_events enable row level security;

-- No new policies on companies. companies_update_staff is the only update
-- policy, so a client cannot write its own tier or trial date, and
-- companies_select already allows id = private.user_company_id(), which is
-- what the trial banner reads.
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: applies cleanly, no error.

If you are working against a hosted project rather than a local stack, apply it with the Supabase MCP `apply_migration` tool instead, using the same file contents.

- [ ] **Step 3: Verify the columns landed**

Run this against the database:

```sql
select column_name from information_schema.columns
 where table_name = 'companies'
   and column_name in ('trial_ends_at','stripe_customer_id',
                       'stripe_subscription_id','subscription_status',
                       'hourly_rate_cents')
 order by column_name;
```

Expected: exactly 5 rows.

Then confirm no free company was left without a clock:

```sql
select count(*) from public.companies
 where subscription_tier = 'free' and trial_ends_at is null;
```

Expected: `0`.

- [ ] **Step 4: Document the env vars**

Append to `.env.local.example`:

```
# Stripe secret key, server-side only. Dashboard -> Developers -> API keys.
STRIPE_SECRET_KEY=
# Signing secret for the webhook endpoint. The local value comes from
# `stripe listen`; the production value from the dashboard webhook endpoint.
# They are NOT interchangeable.
STRIPE_WEBHOOK_SECRET=
# Recurring price ids. SUB4 is the $150/mo plan, SUB20 the $250/mo plan.
# No NEXT_PUBLIC_ prefix: nothing in the browser reads these.
STRIPE_PRICE_SUB4=
STRIPE_PRICE_SUB20=
# Trusted public origin, e.g. https://costs.cloudassistone.com . Used to build
# Stripe's success_url, cancel_url and portal return_url. Preferred over the
# request origin, which comes from the Host header and can be forged.
NEXT_PUBLIC_SITE_URL=
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260904000000_stripe_billing.sql .env.local.example
git commit -m "Add Stripe billing schema and trial clock" -- supabase/migrations/20260904000000_stripe_billing.sql .env.local.example
```

---

### Task 2: Access resolution

**Files:**
- Create: `lib/companyAccess.ts`
- Test: `lib/companyAccess.test.ts`

**Interfaces:**
- Consumes: `SubscriptionTier` and `isSubscriptionTier` from `lib/subscriptionTiers.ts`.
- Produces: `CompanyBillingRow`, `CompanyAccess`, `resolveCompanyAccess(row: CompanyBillingRow | null, now?: Date): CompanyAccess`, `trialDaysLeft(trialEndsAt: string | null, now?: Date): number`.

- [ ] **Step 1: Write the failing test**

Create `lib/companyAccess.test.ts`:

```ts
import { resolveCompanyAccess, trialDaysLeft } from './companyAccess';

const NOW = new Date('2026-09-04T12:00:00Z');

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

describe('resolveCompanyAccess', () => {
  it('treats a paid tier with no Stripe subscription as exempt', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_unlimited',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access).toEqual({ state: 'exempt', tier: 'subscription_unlimited' });
  });

  it('reports past_due for a paid tier whose card failed', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'past_due',
      },
      NOW
    );

    expect(access).toEqual({ state: 'past_due', tier: 'subscription_4' });
  });

  it('reports active for a paid tier in good standing', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_20',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'active',
      },
      NOW
    );

    expect(access).toEqual({ state: 'active', tier: 'subscription_20' });
  });

  it('counts down a free company still inside its trial', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: daysFromNow(23),
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trialing');
    if (access.state === 'trialing') expect(access.daysLeft).toBe(23);
  });

  it('expires the moment the trial end is reached', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: NOW.toISOString(),
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks a canceled subscription, which the webhook returns to free', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: daysFromNow(-60),
        stripe_subscription_id: 'sub_123',
        subscription_status: 'canceled',
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks rather than opens when the row is missing', () => {
    expect(resolveCompanyAccess(null, NOW).state).toBe('trial_expired');
  });

  it('locks rather than opens on an unrecognised tier', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'enterprise_gold',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks rather than opens when a free company has no trial date', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });
});

describe('trialDaysLeft', () => {
  it('rounds a partial day up, so 30.5 days reads as 31', () => {
    expect(trialDaysLeft(daysFromNow(30.5), NOW)).toBe(31);
  });

  it('never goes negative', () => {
    expect(trialDaysLeft(daysFromNow(-5), NOW)).toBe(0);
  });

  it('is 0 for a null date', () => {
    expect(trialDaysLeft(null, NOW)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- companyAccess`
Expected: FAIL, cannot find module `./companyAccess`.

- [ ] **Step 3: Write the implementation**

Create `lib/companyAccess.ts`:

```ts
import { isSubscriptionTier, type SubscriptionTier } from '@/lib/subscriptionTiers';

/** The billing-relevant columns of a company row. */
export interface CompanyBillingRow {
  subscription_tier: string | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
}

export type CompanyAccess =
  | { state: 'trialing'; daysLeft: number; trialEndsAt: string }
  | { state: 'trial_expired'; trialEndsAt: string | null }
  | { state: 'active'; tier: SubscriptionTier }
  | { state: 'past_due'; tier: SubscriptionTier }
  | { state: 'exempt'; tier: SubscriptionTier };

const MS_PER_DAY = 86_400_000;

/** Whole days remaining, rounded up, floored at 0. */
export function trialDaysLeft(trialEndsAt: string | null, now: Date = new Date()): number {
  if (!trialEndsAt) return 0;
  const ends = new Date(trialEndsAt).getTime();
  if (Number.isNaN(ends)) return 0;
  return Math.max(0, Math.ceil((ends - now.getTime()) / MS_PER_DAY));
}

/**
 * Order matters. Rule 5 is the catch-all that locks anything we cannot
 * positively identify as paid or in-trial, which is also how cancellation
 * works: the webhook returns a canceled company to 'free', and its long-past
 * trial_ends_at drops it straight to trial_expired with no separate path.
 */
export function resolveCompanyAccess(
  row: CompanyBillingRow | null,
  now: Date = new Date()
): CompanyAccess {
  if (!row) return { state: 'trial_expired', trialEndsAt: null };

  const tier = row.subscription_tier;

  if (isSubscriptionTier(tier) && tier !== 'free') {
    // A paid tier with no Stripe subscription was granted by an admin --
    // every subscription_unlimited customer, plus anyone predating billing.
    // These must never be gated.
    if (!row.stripe_subscription_id) return { state: 'exempt', tier };

    if (row.subscription_status === 'past_due') return { state: 'past_due', tier };

    if (row.subscription_status === 'active' || row.subscription_status === 'trialing') {
      return { state: 'active', tier };
    }
  }

  if (tier === 'free' && row.trial_ends_at) {
    const ends = new Date(row.trial_ends_at).getTime();
    if (!Number.isNaN(ends) && ends > now.getTime()) {
      return {
        state: 'trialing',
        daysLeft: trialDaysLeft(row.trial_ends_at, now),
        trialEndsAt: row.trial_ends_at,
      };
    }
  }

  return { state: 'trial_expired', trialEndsAt: row.trial_ends_at };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- companyAccess`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/companyAccess.ts lib/companyAccess.test.ts
git commit -m "Resolve company billing access from tier and trial date" -- lib/companyAccess.ts lib/companyAccess.test.ts
```

---

### Task 3: Consulting rate and rounding

**Files:**
- Create: `lib/consultingRate.ts`
- Test: `lib/consultingRate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_HOURLY_RATE_CENTS`, `hourlyRateCentsFor(companyRate: number | null | undefined): number`, `invoiceAmountCents(minutes: number, rateCents: number): number`.

**There is deliberately no `formatHours`.** An earlier draft rendered the
invoice line's quantity as decimal hours rounded to two places while charging
the exact cents for the raw minutes. Those two disagree for any duration that
is not a clean fraction of an hour: 50 minutes displays as `0.83h` but is
charged `$145.83`, and a customer multiplying `0.83 x $175` gets `$145.25`.
Invoice lines therefore state the billable time in **minutes**, the same unit
staff actually log, so the displayed quantity and the charged amount always
reconcile exactly.

- [ ] **Step 1: Write the failing test**

Create `lib/consultingRate.test.ts`:

```ts
import {
  DEFAULT_HOURLY_RATE_CENTS,
  hourlyRateCentsFor,
  invoiceAmountCents,
} from './consultingRate';

describe('hourlyRateCentsFor', () => {
  it('defaults to $175/hr when the company has no rate', () => {
    expect(DEFAULT_HOURLY_RATE_CENTS).toBe(17500);
    expect(hourlyRateCentsFor(null)).toBe(17500);
    expect(hourlyRateCentsFor(undefined)).toBe(17500);
  });

  it('prefers a negotiated per-company rate', () => {
    expect(hourlyRateCentsFor(22500)).toBe(22500);
  });

  it('honours a deliberate zero rate for pro bono work', () => {
    expect(hourlyRateCentsFor(0)).toBe(0);
  });

  it('falls back to the default on a nonsense rate', () => {
    expect(hourlyRateCentsFor(-100)).toBe(17500);
    expect(hourlyRateCentsFor(Number.NaN)).toBe(17500);
  });
});

describe('invoiceAmountCents', () => {
  it('bills a whole hour at the full rate', () => {
    expect(invoiceAmountCents(60, 17500)).toBe(17500);
  });

  it('bills 90 minutes at one and a half times the rate', () => {
    expect(invoiceAmountCents(90, 17500)).toBe(26250);
  });

  it('returns whole cents for a rate that does not divide evenly', () => {
    const amount = invoiceAmountCents(50, 17500);
    expect(amount).toBe(14583);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it('is 0 for zero minutes', () => {
    expect(invoiceAmountCents(0, 17500)).toBe(0);
  });

  // These feed real Stripe invoice items. A defect upstream must not become a
  // negative or NaN charge on a customer's card.
  it('never produces a negative charge', () => {
    expect(invoiceAmountCents(-30, 17500)).toBe(0);
  });

  it('is 0 for non-finite minutes rather than propagating NaN', () => {
    expect(invoiceAmountCents(Number.NaN, 17500)).toBe(0);
    expect(invoiceAmountCents(Number.POSITIVE_INFINITY, 17500)).toBe(0);
  });

  it('is 0 for a non-finite rate', () => {
    expect(invoiceAmountCents(60, Number.NaN)).toBe(0);
  });

  it('never returns -0', () => {
    expect(Object.is(invoiceAmountCents(0, 17500), -0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- consultingRate`
Expected: FAIL, cannot find module `./consultingRate`.

- [ ] **Step 3: Write the implementation**

Create `lib/consultingRate.ts`:

```ts
/**
 * The standard consulting rate, in cents. Not a secret, so it lives in
 * version control where a change is reviewable rather than in an env var.
 * A company may override it via companies.hourly_rate_cents.
 */
export const DEFAULT_HOURLY_RATE_CENTS = 17_500;

export function hourlyRateCentsFor(companyRate: number | null | undefined): number {
  if (typeof companyRate !== 'number') return DEFAULT_HOURLY_RATE_CENTS;
  if (!Number.isFinite(companyRate) || companyRate < 0) return DEFAULT_HOURLY_RATE_CENTS;
  return Math.round(companyRate);
}

/**
 * Integer cents throughout -- money never touches a float we keep.
 *
 * Guarded, unlike a naive multiply: these amounts become real Stripe invoice
 * items, so a negative duration or a NaN leaking in from upstream must resolve
 * to zero rather than becoming a negative charge or a NaN on a customer's
 * invoice. `|| 0` also normalises -0 to 0.
 */
export function invoiceAmountCents(minutes: number, rateCents: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(rateCents)) return 0;
  if (minutes <= 0 || rateCents <= 0) return 0;
  return Math.round((minutes / 60) * rateCents) || 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- consultingRate`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/consultingRate.ts lib/consultingRate.test.ts
git commit -m "Add consulting rate resolution and cent-accurate rounding" -- lib/consultingRate.ts lib/consultingRate.test.ts
```

---

### Task 4: Stripe client and tier mapping

**Files:**
- Create: `lib/stripe.ts`
- Test: `lib/stripe.test.ts`
- Modify: `package.json` (adds the `stripe` dependency)

**Interfaces:**
- Consumes: `SubscriptionTier` from `lib/subscriptionTiers.ts`.
- Produces: `getStripe(): Stripe`, `PURCHASABLE_TIERS`, `isPurchasableTier(value: unknown): value is PurchasableTier`, `priceIdForTier(tier: PurchasableTier): string`, `tierForPriceId(priceId: string): SubscriptionTier | null`.

- [ ] **Step 1: Install the Stripe SDK**

Run: `npm install stripe`

This is the plan's only new dependency.

- [ ] **Step 2: Write the failing test**

Create `lib/stripe.test.ts`:

```ts
import { isPurchasableTier, priceIdForTier, tierForPriceId } from './stripe';

describe('purchasable tiers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      STRIPE_PRICE_SUB4: 'price_sub4',
      STRIPE_PRICE_SUB20: 'price_sub20',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts only the two tiers a customer can buy', () => {
    expect(isPurchasableTier('subscription_4')).toBe(true);
    expect(isPurchasableTier('subscription_20')).toBe(true);
  });

  it('rejects the sales-only and free tiers', () => {
    // subscription_unlimited has no Stripe price by design: it is granted by
    // an admin, never bought.
    expect(isPurchasableTier('subscription_unlimited')).toBe(false);
    expect(isPurchasableTier('free')).toBe(false);
  });

  it('rejects anything that is not a known tier', () => {
    expect(isPurchasableTier('price_1234')).toBe(false);
    expect(isPurchasableTier(null)).toBe(false);
  });

  it('maps a tier to its configured price id', () => {
    expect(priceIdForTier('subscription_4')).toBe('price_sub4');
    expect(priceIdForTier('subscription_20')).toBe('price_sub20');
  });

  it('throws rather than guessing when a price id is not configured', () => {
    delete process.env.STRIPE_PRICE_SUB4;
    expect(() => priceIdForTier('subscription_4')).toThrow(/STRIPE_PRICE_SUB4/);
  });

  it('maps a price id back to its tier for subscription.updated', () => {
    expect(tierForPriceId('price_sub20')).toBe('subscription_20');
  });

  it('returns null for an unknown price id', () => {
    expect(tierForPriceId('price_from_another_account')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- lib/stripe`
Expected: FAIL, cannot find module `./stripe`.

- [ ] **Step 4: Write the implementation**

Create `lib/stripe.ts`:

```ts
import Stripe from 'stripe';
import type { SubscriptionTier } from '@/lib/subscriptionTiers';

/** The tiers a customer can buy. subscription_unlimited is admin-granted. */
export const PURCHASABLE_TIERS = ['subscription_4', 'subscription_20'] as const;

export type PurchasableTier = (typeof PURCHASABLE_TIERS)[number];

const PRICE_ENV_VAR: Record<PurchasableTier, string> = {
  subscription_4: 'STRIPE_PRICE_SUB4',
  subscription_20: 'STRIPE_PRICE_SUB20',
};

export function isPurchasableTier(value: unknown): value is PurchasableTier {
  return typeof value === 'string' && (PURCHASABLE_TIERS as readonly string[]).includes(value);
}

/**
 * Throws rather than returning a fallback: a missing price id is a
 * deployment mistake, and quietly charging the wrong plan is far worse than
 * a failed checkout.
 */
export function priceIdForTier(tier: PurchasableTier): string {
  const envVar = PRICE_ENV_VAR[tier];
  const priceId = (process.env[envVar] ?? '').trim();
  if (!priceId) throw new Error(`${envVar} is not set, so ${tier} cannot be sold.`);
  return priceId;
}

/** Reverse lookup for customer.subscription.updated. */
export function tierForPriceId(priceId: string): SubscriptionTier | null {
  for (const tier of PURCHASABLE_TIERS) {
    if ((process.env[PRICE_ENV_VAR[tier]] ?? '').trim() === priceId) return tier;
  }
  return null;
}

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = (process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  cached = new Stripe(key);
  return cached;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- lib/stripe`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/stripe.ts lib/stripe.test.ts package.json package-lock.json
git commit -m "Add Stripe client and tier-to-price mapping" -- lib/stripe.ts lib/stripe.test.ts package.json package-lock.json
```

---

### Task 5: Server-side access lookup and the API guard

**Files:**
- Create: `lib/companyBilling.ts`
- Create: `lib/billingGuard.ts`
- Test: `lib/companyBilling.test.ts`

**Interfaces:**
- Consumes: `resolveCompanyAccess`, `CompanyAccess` from `lib/companyAccess.ts`; `createAdminClient` from `lib/supabase/admin.ts`.
- Produces: `fetchCompanyAccess(adminClient, companyId: string): Promise<CompanyAccess>`; `requireActiveBilling(companyId: string): Promise<BillingGuardResult>` where `BillingGuardResult = { allowed: true } | { allowed: false; status: number; message: string }`.

- [ ] **Step 1: Write the failing test**

Create `lib/companyBilling.test.ts`:

```ts
import { fetchCompanyAccess } from './companyBilling';

type Row = {
  subscription_tier: string | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
};

// Recording fake of the Supabase admin client, following the pattern in
// connectionAllowance.test.ts.
function createFakeAdminClient(opts: { row?: Row | null; error?: string } = {}) {
  const captured: Record<string, unknown> = {};

  return {
    captured,
    from(table: string) {
      captured.table = table;
      return {
        select: (columns: string) => {
          captured.columns = columns;
          return {
            eq: (column: string, value: unknown) => {
              captured.eqColumn = column;
              captured.eqValue = value;
              return {
                maybeSingle: () =>
                  Promise.resolve(
                    opts.error
                      ? { data: null, error: { message: opts.error } }
                      : { data: opts.row ?? null, error: null }
                  ),
              };
            },
          };
        },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAdminClient = (fake: unknown) => fake as any;

describe('fetchCompanyAccess', () => {
  it('reads the billing columns for the given company', async () => {
    const fake = createFakeAdminClient({
      row: {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_1',
        subscription_status: 'active',
      },
    });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'company-1');

    expect(fake.captured.table).toBe('companies');
    expect(fake.captured.eqColumn).toBe('id');
    expect(fake.captured.eqValue).toBe('company-1');
    expect(access).toEqual({ state: 'active', tier: 'subscription_4' });
  });

  it('locks rather than opens when the lookup fails', async () => {
    const fake = createFakeAdminClient({ error: 'connection reset' });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'company-1');

    expect(access.state).toBe('trial_expired');
  });

  it('locks when the company does not exist', async () => {
    const fake = createFakeAdminClient({ row: null });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'missing');

    expect(access.state).toBe('trial_expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- companyBilling`
Expected: FAIL, cannot find module `./companyBilling`.

- [ ] **Step 3: Write the lookup**

Create `lib/companyBilling.ts`:

```ts
import type { createAdminClient } from '@/lib/supabase/admin';
import { resolveCompanyAccess, type CompanyAccess } from '@/lib/companyAccess';

const BILLING_COLUMNS =
  'subscription_tier, trial_ends_at, stripe_subscription_id, subscription_status';

/**
 * A lookup failure must never hand out access: an unverifiable company is
 * treated as expired, the same way getConnectionAllowance refuses rather
 * than granting a connection it could not verify.
 */
export async function fetchCompanyAccess(
  adminClient: ReturnType<typeof createAdminClient>,
  companyId: string
): Promise<CompanyAccess> {
  const { data, error } = await adminClient
    .from('companies')
    .select(BILLING_COLUMNS)
    .eq('id', companyId)
    .maybeSingle();

  if (error) return { state: 'trial_expired', trialEndsAt: null };

  return resolveCompanyAccess(data ?? null);
}
```

- [ ] **Step 4: Write the guard**

Create `lib/billingGuard.ts`:

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';

export type BillingGuardResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

/**
 * The real enforcement. The UI swap in app/page.tsx is a courtesy -- a user
 * can POST directly, so every mutating route calls this. Same reasoning as
 * the comment in connectionAllowance.ts.
 */
export async function requireActiveBilling(companyId: string): Promise<BillingGuardResult> {
  const access = await fetchCompanyAccess(createAdminClient(), companyId);

  if (access.state === 'trial_expired') {
    return {
      allowed: false,
      status: 403,
      message: 'Your free trial has ended. Add a payment method to continue.',
    };
  }

  return { allowed: true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- companyBilling`
Expected: PASS, 3 tests.

- [ ] **Step 6: Apply the guard to one mutating route**

Modify `app/api/upload/route.ts`. Add the import alongside the existing ones:

```ts
import { requireActiveBilling } from '@/lib/billingGuard';
```

Then find this existing block:

```ts
  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }
```

and insert directly beneath it, before `const adminClient = createAdminClient();`:

```ts
  // Billing is checked after identity: a caller must be authenticated and
  // entitled to this company before we tell them anything about its plan.
  const billing = await requireActiveBilling(companyId);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
  }
```

`companyId` is already a validated `string` at that point, taken from the form data above.

This route is the template. Applying the same three-line block to the remaining mutating routes (`app/api/aws`, `app/api/azure`, `app/api/periods`, `app/api/billing-sources`) is mechanical and belongs in the follow-up, since each needs its own read to confirm where `companyId` is in scope.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add lib/companyBilling.ts lib/companyBilling.test.ts lib/billingGuard.ts app/api/upload/route.ts
git commit -m "Add billing guard for mutating routes" -- lib/companyBilling.ts lib/companyBilling.test.ts lib/billingGuard.ts app/api/upload/route.ts
```

---

### Task 6: Trial banner and the hard lock

**Files:**
- Create: `components/billing/TrialBanner.tsx`
- Create: `components/billing/TrialExpired.tsx`
- Test: `components/billing/TrialBanner.test.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `CompanyAccess` from `lib/companyAccess.ts`; `fetchCompanyAccess` from `lib/companyBilling.ts`.
- Produces: `<TrialBanner access={access} />`, `<TrialExpired />`.

- [ ] **Step 1: Write the failing test**

Create `components/billing/TrialBanner.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import TrialBanner from './TrialBanner';

describe('TrialBanner', () => {
  it('shows the days remaining during a trial', () => {
    render(
      <TrialBanner access={{ state: 'trialing', daysLeft: 23, trialEndsAt: '2026-09-27T12:00:00Z' }} />
    );

    expect(screen.getByText(/23 days left/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add payment method/i })).toBeInTheDocument();
  });

  it('uses the singular on the final day', () => {
    render(
      <TrialBanner access={{ state: 'trialing', daysLeft: 1, trialEndsAt: '2026-09-05T12:00:00Z' }} />
    );

    expect(screen.getByText(/1 day left/i)).toBeInTheDocument();
  });

  it('warns urgently when a payment has failed', () => {
    render(<TrialBanner access={{ state: 'past_due', tier: 'subscription_4' }} />);

    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
  });

  it('renders nothing for a paying customer', () => {
    const { container } = render(
      <TrialBanner access={{ state: 'active', tier: 'subscription_4' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an admin-granted account', () => {
    const { container } = render(
      <TrialBanner access={{ state: 'exempt', tier: 'subscription_unlimited' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
```

If `@testing-library/react` and `@testing-library/jest-dom` are not already dev dependencies, install them first: `npm install -D @testing-library/react @testing-library/jest-dom`, and ensure `jest.setup.ts` contains `import '@testing-library/jest-dom';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- TrialBanner`
Expected: FAIL, cannot find module `./TrialBanner`.

- [ ] **Step 3: Write the banner**

Create `components/billing/TrialBanner.tsx`:

```tsx
import type { CompanyAccess } from '@/lib/companyAccess';

// Urgency rises as the trial runs out: neutral above a week, amber inside a
// week, red in the last three days and on a failed payment.
function toneFor(daysLeft: number): string {
  if (daysLeft <= 3) return 'bg-red-600 text-white';
  if (daysLeft <= 7) return 'bg-amber-500 text-black';
  return 'bg-slate-800 text-white';
}

export default function TrialBanner({ access }: { access: CompanyAccess }) {
  if (access.state === 'active' || access.state === 'exempt') return null;

  if (access.state === 'past_due') {
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-2 bg-red-600 text-white">
        <span>Payment failed. Update your card to avoid losing access.</span>
        <a href="/billing" className="underline font-medium">
          Update payment method
        </a>
      </div>
    );
  }

  if (access.state === 'trial_expired') {
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-2 bg-red-600 text-white">
        <span>Your free trial has ended.</span>
        <a href="/billing" className="underline font-medium">
          Add payment method
        </a>
      </div>
    );
  }

  const { daysLeft } = access;
  const unit = daysLeft === 1 ? 'day' : 'days';

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 ${toneFor(daysLeft)}`}>
      <span>
        {daysLeft} {unit} left in your free trial.
      </span>
      <a href="/billing" className="underline font-medium">
        Add payment method
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Write the lock screen**

Create `components/billing/TrialExpired.tsx`:

```tsx
export default function TrialExpired() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold">Your free trial has ended</h1>
      <p className="text-muted-foreground">
        Your cost data is safe and untouched. Add a payment method and everything
        comes straight back.
      </p>
      <a
        href="/billing"
        className="mx-auto rounded-md bg-slate-900 px-6 py-3 font-medium text-white dark:bg-white dark:text-slate-900"
      >
        Choose a plan
      </a>
    </main>
  );
}
```

- [ ] **Step 5: Wire the lock into the page**

Modify `app/page.tsx`. Keep the existing user and profile lookup, then gate on access. `AppShell` is what mounts every data tab, so swapping it out means nothing gated ever reaches the browser:

```tsx
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';
import LoginForm from '@/components/auth/LoginForm';
import AppShell from '@/components/shell/AppShell';
import TrialBanner from '@/components/billing/TrialBanner';
import TrialExpired from '@/components/billing/TrialExpired';

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <LoginForm />;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, company_id')
    .eq('id', user.id)
    .single();

  const role = profile?.role === 'admin' ? 'admin' : profile?.role === 'staff' ? 'staff' : 'client';

  // Staff and admins run the business; they are never gated by a client's
  // billing state.
  const isInternal = role === 'staff' || role === 'admin';
  const access = profile?.company_id
    ? await fetchCompanyAccess(createAdminClient(), profile.company_id)
    : null;

  if (!isInternal && access?.state === 'trial_expired') {
    return <TrialExpired />;
  }

  return (
    <>
      {!isInternal && access ? <TrialBanner access={access} /> : null}
      <AppShell
        userId={user.id}
        role={role}
        companyId={profile?.company_id ?? null}
        userEmail={user.email ?? ''}
      />
    </>
  );
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- TrialBanner`
Expected: PASS, 5 tests.

Then `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add components/billing/TrialBanner.tsx components/billing/TrialBanner.test.tsx components/billing/TrialExpired.tsx app/page.tsx
git commit -m "Show trial countdown and lock the app when it expires" -- components/billing/TrialBanner.tsx components/billing/TrialBanner.test.tsx components/billing/TrialExpired.tsx app/page.tsx
```

---

### Task 7: Checkout and billing portal routes

**Files:**
- Create: `app/api/billing/checkout/route.ts`
- Create: `app/api/billing/portal/route.ts`
- Test: `app/api/billing/checkout/route.test.ts`

**Interfaces:**
- Consumes: `getStripe`, `isPurchasableTier`, `priceIdForTier` from `lib/stripe.ts`; `requireCompanyAccess` from `lib/admin-guard.ts`.
- Produces: `POST /api/billing/checkout` taking `{ companyId, tier }` and returning `{ url }`; `POST /api/billing/portal` taking `{ companyId }` and returning `{ url }`.

- [ ] **Step 1: Write the failing test**

Create `app/api/billing/checkout/route.test.ts`:

```ts
import { POST } from './route';

jest.mock('@/lib/admin-guard', () => ({
  requireCompanyAccess: jest.fn(),
}));

jest.mock('@/lib/supabase/admin', () => ({
  createAdminClient: jest.fn(),
}));

jest.mock('@/lib/stripe', () => {
  const actual = jest.requireActual('@/lib/stripe');
  return { ...actual, getStripe: jest.fn() };
});

import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

function request(body: unknown) {
  return new Request('http://localhost/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const companyRow = {
  id: 'company-1',
  stripe_customer_id: 'cus_existing',
  name: 'Acme',
};

function stubAdminClient() {
  const updates: Record<string, unknown>[] = [];
  (createAdminClient as jest.Mock).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: companyRow, error: null }) }),
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  });
  return updates;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
  (requireCompanyAccess as jest.Mock).mockResolvedValue({
    authorized: true,
    userId: 'user-1',
    role: 'client',
  });
});

describe('POST /api/billing/checkout', () => {
  it('rejects a caller who is not signed in', async () => {
    (requireCompanyAccess as jest.Mock).mockResolvedValue({
      authorized: false,
      status: 401,
      message: 'Not signed in.',
    });

    const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));

    expect(response.status).toBe(401);
  });

  it('refuses a tier that is not purchasable', async () => {
    stubAdminClient();

    const response = await POST(
      request({ companyId: 'company-1', tier: 'subscription_unlimited' })
    );

    expect(response.status).toBe(400);
  });

  it('ignores any price id the client tries to supply', async () => {
    stubAdminClient();
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
    (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

    await POST(
      request({
        companyId: 'company-1',
        tier: 'subscription_4',
        priceId: 'price_attacker_zero_dollars',
      })
    );

    const args = create.mock.calls[0][0];
    expect(args.line_items[0].price).toBe('price_sub4');
  });

  it('returns the Stripe-hosted checkout url', async () => {
    stubAdminClient();
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
    (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

    const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/123');

    const args = create.mock.calls[0][0];
    expect(args.mode).toBe('subscription');
    expect(args.customer).toBe('cus_existing');
    expect(args.metadata).toEqual({ company_id: 'company-1', tier: 'subscription_4' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- billing/checkout`
Expected: FAIL, cannot find module `./route`.

- [ ] **Step 3: Write the checkout route**

Create `app/api/billing/checkout/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe, isPurchasableTier, priceIdForTier } from '@/lib/stripe';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;
  const tier = body?.tier;

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  // The price id is derived from the tier server-side and never read from the
  // request. Trusting a client-supplied price would let a caller pass a $0
  // price from another Stripe account and take a paid tier for nothing.
  if (!isPurchasableTier(tier)) {
    return NextResponse.json({ error: 'That plan is not available to buy.' }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: company, error } = await adminClient
    .from('companies')
    .select('id, name, stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  if (error || !company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  const stripe = getStripe();
  let customerId = company.stripe_customer_id as string | null;

  if (!customerId) {
    const customer = await stripe.customers.create({
      name: company.name as string,
      metadata: { company_id: companyId },
    });
    customerId = customer.id;
    await adminClient
      .from('companies')
      .update({ stripe_customer_id: customerId })
      .eq('id', companyId);
  }

  const origin = request.nextUrl?.origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceIdForTier(tier), quantity: 1 }],
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    metadata: { company_id: companyId, tier },
    subscription_data: { metadata: { company_id: companyId, tier } },
  });

  return NextResponse.json({ url: session.url });
}
```

- [ ] **Step 4: Write the portal route**

Create `app/api/billing/portal/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { data: company } = await createAdminClient()
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', companyId)
    .maybeSingle();

  const customerId = company?.stripe_customer_id as string | null | undefined;
  if (!customerId) {
    return NextResponse.json({ error: 'No billing account yet.' }, { status: 400 });
  }

  const origin = request.nextUrl?.origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? '';

  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: session.url });
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- billing/checkout`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add app/api/billing/checkout/route.ts app/api/billing/checkout/route.test.ts app/api/billing/portal/route.ts
git commit -m "Add Stripe checkout and billing portal routes" -- app/api/billing/checkout/route.ts app/api/billing/checkout/route.test.ts app/api/billing/portal/route.ts
```

---

### Task 8: Billing page

**Files:**
- Create: `app/billing/page.tsx`
- Create: `components/billing/PlanCards.tsx`

**Interfaces:**
- Consumes: `fetchCompanyAccess` from `lib/companyBilling.ts`; `POST /api/billing/checkout` and `POST /api/billing/portal`.
- Produces: the `/billing` route.

- [ ] **Step 1: Write the plan cards**

Create `components/billing/PlanCards.tsx`:

```tsx
'use client';

import { useState } from 'react';
import type { CompanyAccess } from '@/lib/companyAccess';

const PLANS = [
  {
    tier: 'subscription_4' as const,
    name: 'Subscription 4',
    price: '$150',
    blurb: 'Up to 4 cloud connections.',
  },
  {
    tier: 'subscription_20' as const,
    name: 'Subscription 20',
    price: '$250',
    blurb: 'Up to 20 cloud connections.',
  },
];

export default function PlanCards({
  companyId,
  access,
  hasCustomer,
}: {
  companyId: string;
  access: CompanyAccess;
  hasCustomer: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Something went wrong.');
      window.location.href = data.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      setBusy(null);
    }
  }

  const currentTier = access.state === 'active' || access.state === 'past_due' ? access.tier : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((plan) => (
          <div key={plan.tier} className="rounded-lg border p-6">
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p className="mt-1 text-3xl font-bold">
              {plan.price}
              <span className="text-base font-normal">/mo</span>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{plan.blurb}</p>
            <button
              type="button"
              disabled={busy !== null || currentTier === plan.tier}
              onClick={() => go('/api/billing/checkout', { companyId, tier: plan.tier }, plan.tier)}
              className="mt-4 w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
            >
              {currentTier === plan.tier
                ? 'Current plan'
                : busy === plan.tier
                  ? 'Opening Stripe...'
                  : `Choose ${plan.name}`}
            </button>
          </div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Need more than 20 connections? Contact us and we will set you up.
      </p>

      {hasCustomer ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => go('/api/billing/portal', { companyId }, 'portal')}
          className="self-start rounded-md border px-4 py-2 font-medium disabled:opacity-50"
        >
          {busy === 'portal' ? 'Opening Stripe...' : 'Manage billing'}
        </button>
      ) : null}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `app/billing/page.tsx`:

```tsx
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';
import LoginForm from '@/components/auth/LoginForm';
import PlanCards from '@/components/billing/PlanCards';

export default async function BillingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return <LoginForm />;

  const { data: profile } = await supabase
    .from('profiles')
    .select('company_id')
    .eq('id', user.id)
    .single();

  if (!profile?.company_id) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p>No company is linked to your account.</p>
      </main>
    );
  }

  const adminClient = createAdminClient();
  const access = await fetchCompanyAccess(adminClient, profile.company_id);
  const { data: company } = await adminClient
    .from('companies')
    .select('stripe_customer_id')
    .eq('id', profile.company_id)
    .maybeSingle();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <div>
        <h1 className="text-3xl font-semibold">Billing</h1>
        {access.state === 'trialing' ? (
          <p className="mt-2 text-muted-foreground">
            {access.daysLeft} {access.daysLeft === 1 ? 'day' : 'days'} left in your free trial.
          </p>
        ) : null}
        {access.state === 'trial_expired' ? (
          <p className="mt-2 text-muted-foreground">
            Your trial has ended. Choose a plan to restore access.
          </p>
        ) : null}
        {access.state === 'past_due' ? (
          <p className="mt-2 text-red-600">
            Your last payment failed. Update your card to keep your account active.
          </p>
        ) : null}
      </div>

      <PlanCards
        companyId={profile.company_id}
        access={access}
        hasCustomer={Boolean(company?.stripe_customer_id)}
      />
    </main>
  );
}
```

- [ ] **Step 3: Verify it renders**

Run: `npm run build`
Expected: build succeeds, `/billing` appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add app/billing/page.tsx components/billing/PlanCards.tsx
git commit -m "Add billing page with plan cards and portal link" -- app/billing/page.tsx components/billing/PlanCards.tsx
```

---

### Task 9: Stripe webhook

**Files:**
- Create: `app/api/billing/webhook/route.ts`
- Create: `lib/stripeWebhook.ts`
- Test: `lib/stripeWebhook.test.ts`

**Interfaces:**
- Consumes: `tierForPriceId` from `lib/stripe.ts`.
- Produces: `CompanyUpdate = { match: { column: 'id' | 'stripe_customer_id'; value: string }; values: Record<string, unknown> }`; `companyUpdateForEvent(event: { type: string; data: { object: Record<string, unknown> } }): CompanyUpdate | null`; `POST /api/billing/webhook`.

The decision of what each event writes is pulled into a pure function so it can be tested without mocking Stripe's signature verification.

**Why the update carries a `match` rather than a company id.** Stripe invoice
objects do **not** inherit their subscription's metadata. Reading
`metadata.company_id` works for `checkout.session.completed` and for
`customer.subscription.*` (Task 7 sets metadata on both the session and the
subscription), but on `invoice.payment_failed` and `invoice.payment_succeeded`
it is absent — so a metadata-only lookup would silently skip those events and
`past_due` would never be recorded, leaving a failed card invisible. Invoice
events therefore match the company by `stripe_customer_id`, which is always
present on an invoice. Everything else matches by `id`.

- [ ] **Step 1: Write the failing test**

Create `lib/stripeWebhook.test.ts`:

```ts
import { companyUpdateForEvent } from './stripeWebhook';

beforeEach(() => {
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
});

describe('companyUpdateForEvent', () => {
  it('activates the bought tier on checkout.session.completed', () => {
    const update = companyUpdateForEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { company_id: 'company-1', tier: 'subscription_4' },
        },
      },
    });

    expect(update).toEqual({
      match: { column: 'id', value: 'company-1' },
      values: {
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        subscription_tier: 'subscription_4',
        subscription_status: 'active',
      },
    });
  });

  it('re-derives the tier from the price on subscription.updated', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { company_id: 'company-1' },
          items: { data: [{ price: { id: 'price_sub20' } }] },
        },
      },
    });

    expect(update?.values).toEqual({
      subscription_tier: 'subscription_20',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
    });
  });

  it('returns a company to free when the subscription is deleted', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_1', metadata: { company_id: 'company-1' }, items: { data: [] } },
      },
    });

    expect(update?.values).toEqual({
      subscription_tier: 'free',
      subscription_status: 'canceled',
      stripe_subscription_id: null,
    });
  });

  // Invoices do not inherit subscription metadata, so these two match on the
  // customer id instead. Matching on metadata here would skip the event and
  // leave a failed card invisible.
  it('marks past_due on a failed payment, matching by customer', () => {
    const update = companyUpdateForEvent({
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });

    expect(update).toEqual({
      match: { column: 'stripe_customer_id', value: 'cus_1' },
      values: { subscription_status: 'past_due' },
    });
  });

  it('restores active on a successful payment, matching by customer', () => {
    const update = companyUpdateForEvent({
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });

    expect(update).toEqual({
      match: { column: 'stripe_customer_id', value: 'cus_1' },
      values: { subscription_status: 'active' },
    });
  });

  it('ignores events it does not handle', () => {
    expect(
      companyUpdateForEvent({ type: 'customer.created', data: { object: {} } })
    ).toBeNull();
  });

  it('ignores an invoice event carrying no customer', () => {
    expect(
      companyUpdateForEvent({
        type: 'invoice.payment_failed',
        data: { object: { subscription: 'sub_1' } },
      })
    ).toBeNull();
  });

  it('ignores a subscription event carrying no company id', () => {
    expect(
      companyUpdateForEvent({
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', status: 'active', items: { data: [] } } },
      })
    ).toBeNull();
  });

  it('keeps the tier unchanged when the price is from another account', () => {
    const update = companyUpdateForEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          metadata: { company_id: 'company-1' },
          items: { data: [{ price: { id: 'price_unknown' } }] },
        },
      },
    });

    expect(update?.values).toEqual({
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stripeWebhook`
Expected: FAIL, cannot find module `./stripeWebhook`.

- [ ] **Step 3: Write the event mapping**

Create `lib/stripeWebhook.ts`:

```ts
import { tierForPriceId } from '@/lib/stripe';

interface MinimalEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

export interface CompanyUpdate {
  match: { column: 'id' | 'stripe_customer_id'; value: string };
  values: Record<string, unknown>;
}

/** Company id from an object's own metadata, set by the checkout route. */
function companyIdOf(object: Record<string, unknown>): string | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const id = metadata?.company_id;
  return typeof id === 'string' && id ? id : null;
}

function customerIdOf(object: Record<string, unknown>): string | null {
  const customer = object.customer;
  return typeof customer === 'string' && customer ? customer : null;
}

/**
 * Pure: decides what a Stripe event means for a company row. Keeping this
 * out of the route lets every event be tested without faking signature
 * verification.
 */
export function companyUpdateForEvent(event: MinimalEvent): CompanyUpdate | null {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;
      const metadata = object.metadata as Record<string, unknown>;
      return {
        match: { column: 'id', value: companyId },
        values: {
          stripe_customer_id: object.customer,
          stripe_subscription_id: object.subscription,
          subscription_tier: metadata.tier,
          subscription_status: 'active',
        },
      };
    }

    case 'customer.subscription.updated': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;

      const items = object.items as { data?: { price?: { id?: string } }[] } | undefined;
      const priceId = items?.data?.[0]?.price?.id;
      const tier = priceId ? tierForPriceId(priceId) : null;

      const values: Record<string, unknown> = {
        subscription_status: object.status,
        stripe_subscription_id: object.id,
      };
      // An unrecognised price means the plan was changed in the Stripe
      // dashboard to something we do not sell. Leave the tier alone rather
      // than guessing a limit.
      if (tier) values.subscription_tier = tier;

      return { match: { column: 'id', value: companyId }, values };
    }

    case 'customer.subscription.deleted': {
      const companyId = companyIdOf(object);
      if (!companyId) return null;
      // Back to free with a long-past trial_ends_at, which resolveCompanyAccess
      // turns into trial_expired. Cancellation needs no separate path.
      return {
        match: { column: 'id', value: companyId },
        values: {
          subscription_tier: 'free',
          subscription_status: 'canceled',
          stripe_subscription_id: null,
        },
      };
    }

    // Stripe invoices do NOT inherit their subscription's metadata, so these
    // two must find the company by customer id. Matching on metadata here
    // would silently skip the event and leave a failed card invisible.
    case 'invoice.payment_failed': {
      const customerId = customerIdOf(object);
      if (!customerId) return null;
      return {
        match: { column: 'stripe_customer_id', value: customerId },
        values: { subscription_status: 'past_due' },
      };
    }

    case 'invoice.payment_succeeded': {
      const customerId = customerIdOf(object);
      if (!customerId) return null;
      return {
        match: { column: 'stripe_customer_id', value: customerId },
        values: { subscription_status: 'active' },
      };
    }

    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stripeWebhook`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the route**

Create `app/api/billing/webhook/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { companyUpdateForEvent } from '@/lib/stripeWebhook';

// The Stripe SDK needs Node crypto for signature verification and fails on
// the Edge runtime.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();

  if (!signature || !secret) {
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 400 });
  }

  // Must be the raw body. Parsing JSON first silently breaks verification.
  const rawBody = await request.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  // Claim the event id first. Stripe can deliver the same event more than
  // once; a primary-key conflict means we already handled it.
  const { error: claimError } = await adminClient
    .from('stripe_events')
    .insert({ id: event.id });

  if (claimError) {
    // 23505 is unique_violation -- genuine proof this event was already
    // processed. ANY OTHER error is not proof of anything: a network blip or
    // a permission problem would otherwise be reported to Stripe as success,
    // stopping its retries and dropping a real payment event permanently.
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }

    console.error(`webhook: could not claim event ${event.id}`, claimError);
    return NextResponse.json({ error: 'Could not claim event.' }, { status: 500 });
  }

  try {
    const update = companyUpdateForEvent(event as never);

    if (update) {
      const { error } = await adminClient
        .from('companies')
        .update(update.values)
        .eq(update.match.column, update.match.value);

      if (error) throw new Error(`companies update failed: ${error.message}`);
    }
  } catch (processingError) {
    // Everything after the claim runs inside this try, because a throw is as
    // damaging as a returned error: companyUpdateForEvent calls
    // tierForPriceId, which throws on a duplicate-price misconfiguration. An
    // escaping throw would leave the claim row in place, so Stripe's retry of
    // this same event id would hit the conflict above and be dismissed as a
    // duplicate -- the update lost permanently, with a 500 in the logs that
    // looks transient.
    const { error: releaseError } = await adminClient
      .from('stripe_events')
      .delete()
      .eq('id', event.id);

    if (releaseError) {
      console.error(
        `webhook: processing failed AND claim release failed for event ${event.id}. ` +
          `This event will be treated as a duplicate on retry and must be replayed by hand.`,
        releaseError
      );
    }

    console.error(`webhook: failed to process event ${event.id}`, processingError);
    return NextResponse.json({ error: 'Could not apply update.' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Verify against real Stripe events**

In one terminal: `npm run dev`

In another:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
```

Copy the printed `whsec_...` into `.env.local` as `STRIPE_WEBHOOK_SECRET`, restart the dev server, then:

```bash
stripe trigger checkout.session.completed
```

Expected: the CLI shows a 200. Sending the same event twice must leave the company row unchanged the second time.

- [ ] **Step 8: Commit**

```bash
git add lib/stripeWebhook.ts lib/stripeWebhook.test.ts app/api/billing/webhook/route.ts
git commit -m "Handle Stripe webhooks with duplicate-safe event claiming" -- lib/stripeWebhook.ts lib/stripeWebhook.test.ts app/api/billing/webhook/route.ts
```

---

### Task 10: Consulting invoices

**Files:**
- Create: `lib/consultingInvoice.ts`
- Create: `app/api/billing/consulting/invoice/route.ts`
- Test: `lib/consultingInvoice.test.ts`

**Interfaces:**
- Consumes: `hourlyRateCentsFor`, `invoiceAmountCents` from `lib/consultingRate.ts`; `getStripe` from `lib/stripe.ts`; `requireAdmin` from `lib/admin-guard.ts`.
- Produces: `TimeEntryRow`, `buildInvoiceLines(entries: TimeEntryRow[], rateCents: number): InvoiceLine[]`; `POST /api/billing/consulting/invoice`.

- [ ] **Step 1: Write the failing test**

Create `lib/consultingInvoice.test.ts`:

```ts
import { buildInvoiceLines } from './consultingInvoice';

const entries = [
  { id: 'entry-1', entry_date: '2026-09-02', minutes_spent: 90, description: 'Cost review call' },
  { id: 'entry-2', entry_date: '2026-09-03', minutes_spent: 30, description: 'Tag cleanup' },
];

describe('buildInvoiceLines', () => {
  it('prices each entry in whole cents at the given rate', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].amountCents).toBe(26250);
    expect(lines[1].amountCents).toBe(8750);
  });

  // Minutes, not decimal hours: a rounded hours figure would not reconcile
  // with the exact cents charged on the same line.
  it('describes the line with date, work and billable minutes', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].description).toBe('2026-09-02 — Cost review call (90 min)');
    expect(lines[1].description).toBe('2026-09-03 — Tag cleanup (30 min)');
  });

  it('keeps the displayed minutes and the charged amount reconcilable', () => {
    // 50 minutes is the case that exposed the old decimal-hours bug.
    const lines = buildInvoiceLines(
      [{ id: 'e', entry_date: '2026-09-04', minutes_spent: 50, description: 'Advice' }],
      17500
    );

    expect(lines[0].description).toContain('(50 min)');
    expect(lines[0].amountCents).toBe(Math.round((50 / 60) * 17500));
  });

  it('derives an idempotency key from the entry id, so a retry cannot double-bill', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].idempotencyKey).toBe('ti_entry-1');
    expect(lines[1].idempotencyKey).toBe('ti_entry-2');
  });

  it('returns nothing for an empty list', () => {
    expect(buildInvoiceLines([], 17500)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- consultingInvoice`
Expected: FAIL, cannot find module `./consultingInvoice`.

- [ ] **Step 3: Write the line builder**

Create `lib/consultingInvoice.ts`:

```ts
import { invoiceAmountCents } from '@/lib/consultingRate';

export interface TimeEntryRow {
  id: string;
  entry_date: string;
  minutes_spent: number;
  description: string;
}

export interface InvoiceLine {
  entryId: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
}

export function buildInvoiceLines(entries: TimeEntryRow[], rateCents: number): InvoiceLine[] {
  return entries.map((entry) => ({
    entryId: entry.id,
    amountCents: invoiceAmountCents(entry.minutes_spent, rateCents),
    // Minutes, the unit staff actually log. Decimal hours rounded for display
    // would not reconcile with the exact cents charged on this same line.
    description: `${entry.entry_date} — ${entry.description} (${entry.minutes_spent} min)`,
    // Keyed on the entry id so that if we crash after Stripe creates the item
    // but before we stamp the row, the retry returns the same item instead of
    // billing the work twice.
    idempotencyKey: `ti_${entry.id}`,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- consultingInvoice`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the route**

Create `app/api/billing/consulting/invoice/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';
import { hourlyRateCentsFor } from '@/lib/consultingRate';
import { buildInvoiceLines, type TimeEntryRow } from '@/lib/consultingInvoice';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const body = await request.json().catch(() => null);
  const companyId = typeof body?.companyId === 'string' ? body.companyId : null;
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  const { data: company } = await adminClient
    .from('companies')
    .select('id, name, stripe_customer_id, hourly_rate_cents')
    .eq('id', companyId)
    .maybeSingle();

  if (!company) {
    return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  }

  // Re-select rather than trusting ids from the browser: the source of truth
  // for "not yet billed" is the database, not the request.
  const { data: entries } = await adminClient
    .from('time_entries')
    .select('id, entry_date, minutes_spent, description')
    .eq('company_id', companyId)
    .eq('billable', true)
    .is('stripe_invoice_id', null)
    .order('entry_date', { ascending: true });

  const unbilled = (entries ?? []) as TimeEntryRow[];
  if (unbilled.length === 0) {
    return NextResponse.json({ error: 'No unbilled hours for this company.' }, { status: 400 });
  }

  const stripe = getStripe();
  let customerId = company.stripe_customer_id as string | null;

  // A consulting-only client may never have subscribed.
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: company.name as string,
      metadata: { company_id: companyId },
    });
    customerId = customer.id;
    await adminClient
      .from('companies')
      .update({ stripe_customer_id: customerId })
      .eq('id', companyId);
  }

  const rateCents = hourlyRateCentsFor(company.hourly_rate_cents as number | null);
  const lines = buildInvoiceLines(unbilled, rateCents);

  for (const line of lines) {
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        amount: line.amountCents,
        currency: 'usd',
        description: line.description,
      },
      { idempotencyKey: line.idempotencyKey }
    );
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 14,
    metadata: { company_id: companyId },
  });

  await stripe.invoices.finalizeInvoice(invoice.id as string);
  await stripe.invoices.sendInvoice(invoice.id as string);

  const { error: stampError } = await adminClient
    .from('time_entries')
    .update({
      stripe_invoice_id: invoice.id,
      invoiced_at: new Date().toISOString(),
      rate_cents_at_invoice: rateCents,
    })
    .in(
      'id',
      lines.map((line) => line.entryId)
    );

  if (stampError) {
    // The invoice exists and was sent. The entries are unstamped, so a retry
    // would re-run the loop above -- but each item carries an idempotency key
    // derived from its entry id, so Stripe returns the existing item rather
    // than billing the work twice. Surface the failure for a manual re-run.
    return NextResponse.json(
      { error: 'Invoice sent, but the time entries could not be marked billed.', invoiceId: invoice.id },
      { status: 500 }
    );
  }

  return NextResponse.json({
    invoiceId: invoice.id,
    entryCount: lines.length,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
  });
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Verify end to end in Stripe test mode**

With `npm run dev` running and a company that has at least one unbilled time entry, POST to the route as an admin. Confirm in the Stripe dashboard that one draft invoice was created, that it lists one line per entry with the expected amounts, and that re-running the request does not add duplicate line items.

- [ ] **Step 8: Commit**

```bash
git add lib/consultingInvoice.ts lib/consultingInvoice.test.ts app/api/billing/consulting/invoice/route.ts
git commit -m "Invoice unbilled consulting hours through Stripe" -- lib/consultingInvoice.ts lib/consultingInvoice.test.ts app/api/billing/consulting/invoice/route.ts
```

---

## Deferred to a follow-up

These are named in the spec's scope but are UI surfaces that depend on every task above, and are best built once the mechanics are proven:

- `components/admin/AdminConsulting.tsx`: an admin screen listing unbilled hours per company with an "Invoice" button calling Task 10's route.
- A `billable` toggle on the existing staff time-logging UI. The column defaults to `true`, so logging keeps working unchanged until this ships.
- Per-company `hourly_rate_cents` editing in `components/admin/AdminCompanies.tsx`. Until then the default rate applies and an override can be set directly in the database.

## Production cutover

1. Create both recurring prices in the **live** Stripe dashboard, $150/mo and $250/mo.
2. Set all four env vars in the production environment. `STRIPE_WEBHOOK_SECRET` must be the value from the live dashboard webhook endpoint, not from `stripe listen`.
3. Register the webhook endpoint at `https://<your-domain>/api/billing/webhook` and subscribe it to exactly the five events in Task 9.
4. Apply the migration. Every free company's clock starts at that moment.
5. Confirm no company was locked out unexpectedly:

```sql
select id, name, subscription_tier, trial_ends_at
  from public.companies
 where subscription_tier = 'free'
 order by trial_ends_at;
```
