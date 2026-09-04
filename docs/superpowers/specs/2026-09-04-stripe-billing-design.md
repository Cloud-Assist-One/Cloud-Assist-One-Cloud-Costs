# Stripe Billing — Design

Date: 2026-09-04
Status: Approved for planning

## Purpose

Turn `companies.subscription_tier` from a value an admin sets by hand into one
that customers buy themselves, and give logged consulting time a path to a paid
invoice.

Three things ship together:

1. A 30-day trial that starts on signup, counts down visibly, and hard-locks the
   account on day 31.
2. Self-serve subscriptions at $150/mo and $250/mo, paid by card through
   Stripe-hosted Checkout.
3. Consulting hours invoiced from existing `time_entries` records.

## What already exists

The tier column and its enforcement are built and tested. This work adds billing
around them; it does not redesign them.

| Thing | Location | State |
| --- | --- | --- |
| `companies.subscription_tier` | `20260828000000_subscription_tiers.sql` | `free`, `subscription_4`, `subscription_20`, `subscription_unlimited` |
| Tier to connection-limit rules | `lib/subscriptionTiers.ts` | Pure functions, tested |
| Connection gating | `lib/connectionAllowance.ts` | Working, tested |
| Manual tier assignment | `components/admin/AdminCompanies.tsx` | Admin sets tier by hand |
| Staff time logging | `time_entries`, `20260820000002_review_workflow_schema.sql` | No rate, no billed flag, no invoice link |

## Decisions

**Price to tier.** $150/mo buys `subscription_4` (4 cloud connections). $250/mo
buys `subscription_20` (20). `subscription_unlimited` is sales-only with no
Stripe price; an admin grants it. This mapping means `connectionAllowance.ts`
keeps working untouched.

A customer needing more than 20 connections has no self-serve path and must
contact sales. This is intended.

**No card up front.** Signup takes no payment details. The trial is tracked in
our database; Stripe learns about a company only when it pays.

**Hard lock on day 31.** Login still works, but every route redirects to the
billing page. No cost data, no dashboards, no exports until a card is entered.
Data is untouched and returns the moment they pay.

**Existing companies.** Companies on `free` get a trial anchored to the deploy
date, so nobody is locked out on day one. Companies already on a paid tier are
unaffected and never gated.

**`past_due` keeps working.** Stripe runs its own retry schedule of roughly two
weeks on a failed card. We show a red banner but do not lock. When Stripe
exhausts retries it moves the subscription to `canceled`, and the normal
cancellation path locks the account. We do not build a second grace timer that
could disagree with Stripe's.

**Consulting is invoiced, not auto-charged.** An admin reviews unbilled entries
and creates a Stripe invoice, sent with 14-day terms. Amounts vary per
engagement, and clients expect to see hours before money moves.

**Rate.** `companies.hourly_rate_cents` when set, otherwise a default of `17500`
($175/hr) defined in `lib/consultingRate.ts`. The rate is not a secret, so it
lives in version control where a change is reviewable.

## Schema

One migration: `supabase/migrations/20260904000000_stripe_billing.sql`.

```sql
alter table public.companies
  add column trial_ends_at timestamptz default now() + interval '30 days',
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column subscription_status text
    check (subscription_status in
      ('trialing','active','past_due','canceled','incomplete'));

update public.companies
   set trial_ends_at = now() + interval '30 days'
 where subscription_tier = 'free';

alter table public.companies
  add column hourly_rate_cents integer check (hourly_rate_cents >= 0);

alter table public.time_entries
  add column billable boolean not null default true,
  add column rate_cents_at_invoice integer,
  add column stripe_invoice_id text,
  add column invoiced_at timestamptz;

create index time_entries_unbilled_idx on public.time_entries (company_id)
  where stripe_invoice_id is null and billable;

create table public.stripe_events (
  id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
```

`rate_cents_at_invoice` is copied onto the entry at invoice time, so changing
your rate later never rewrites what an old invoice said.

A non-null `stripe_invoice_id` is the "already billed" flag. One source of truth
means an entry cannot be billed twice.

`stripe_events` has RLS enabled and no policies: only the service role touches
it.

**No new RLS policies are needed on `companies`.** `companies_update_staff` is
the only update policy, so a client cannot write its own tier or trial date.
`companies_select` already allows `id = private.user_company_id()`, so a client
can read the trial fields the banner needs. Verified against
`20260820000000_core_schema.sql`.

## Access resolution

New `lib/companyAccess.ts`. Pure, no I/O, shaped like `subscriptionTiers.ts`.

```ts
export type CompanyAccess =
  | { state: 'trialing';      daysLeft: number; trialEndsAt: string }
  | { state: 'trial_expired'; trialEndsAt: string | null }
  | { state: 'active';        tier: SubscriptionTier }
  | { state: 'past_due';      tier: SubscriptionTier }
  | { state: 'exempt';        tier: SubscriptionTier };
```

Resolved in this order:

1. Paid tier and no `stripe_subscription_id` gives `exempt`. These are
   admin-granted accounts, including every `subscription_unlimited` customer.
   Never gated.
2. Paid tier and status `past_due` gives `past_due`.
3. Paid tier and status `active` or `trialing` gives `active`.
4. `free` and `trial_ends_at` in the future gives `trialing`.
5. Anything else gives `trial_expired`.

Rule 5 handles cancellation without a separate path. The webhook sets a canceled
company back to `free`; its `trial_ends_at` is long past, so it falls to
`trial_expired` and locks.

Unrecognised or missing values resolve to the most restrictive state, matching
the existing convention in `subscriptionTiers.ts`.

`daysLeft` is `ceil((trial_ends_at - now) / 1 day)`, floored at 0. Lock when
`now >= trial_ends_at`, which makes day 31 fall out of the arithmetic rather
than needing its own rule.

## Enforcement

Two layers. Not in `proxy.ts`, which would add a database query to every request
including static assets.

**`app/layout.tsx`** resolves access once per page load, renders the banner, and
redirects to `/billing` when the state is `trial_expired`.

**A guard in every mutating API route** is the real enforcement. A user can POST
directly, so the UI redirect is a courtesy and this is the fence. Same reasoning
as the existing comment in `connectionAllowance.ts`.

**Banner** lives in the layout so it shows on every tab. Neutral above 7 days,
amber at 7 or fewer, red at 3 or fewer, red for `past_due`. Each carries an
"Add payment method" button. `active` and `exempt` render nothing.

## Upgrade flow

`app/api/billing/checkout/route.ts` — authenticated POST taking
`{ tier: 'subscription_4' | 'subscription_20' }`. The server maps tier to a price
id from env. The client never sends a price id: if it could, a caller could POST
a $0 price from another Stripe account and take a paid tier for nothing. Creates
or reuses `stripe_customer_id`, opens a Checkout Session with
`metadata: { company_id, tier }`, returns the redirect URL.

`app/api/billing/portal/route.ts` — opens Stripe's Billing Portal. Card updates,
invoice history, and cancellation are all Stripe-hosted, so there is no
card-management UI to build and no card data reaches our servers.

`app/billing/page.tsx` — the lock destination. Two plan cards, current status,
and a Manage Billing button once a Stripe customer exists.

## Webhook

`app/api/billing/webhook/route.ts`, with `export const runtime = 'nodejs'`. The
Stripe SDK needs Node crypto and fails on Edge.

Signature verification requires the raw body via `await request.text()`. Parsing
JSON first silently breaks verification.

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | Store customer and subscription ids, set tier from metadata, status `active` |
| `customer.subscription.updated` | Sync status, re-derive tier from the price id |
| `customer.subscription.deleted` | Tier back to `free`, status `canceled` |
| `invoice.payment_failed` | Status `past_due` |
| `invoice.payment_succeeded` | Status `active` |

Stripe can deliver an event more than once and retries anything that does not
return 2xx. The handler inserts the event id into `stripe_events` first; on
primary-key conflict the event was already handled, so it returns 200 and does
nothing. This makes double-upgrading structurally impossible.

Writes use `createAdminClient()` (service role), since Stripe arrives
unauthenticated.

## Consulting invoices

`app/api/billing/consulting/invoice/route.ts`, admin-only:

1. Re-select entries `where stripe_invoice_id is null and billable`. Never trust
   the ids the browser posted.
2. Ensure a `stripe_customer_id` exists. A consulting-only client may never have
   subscribed.
3. Create one Stripe invoice item per entry at
   `Math.round(minutes / 60 * rate_cents)`, integer cents throughout, described
   as `2026-09-02 — Cost review call (1.5h)`.
4. Finalize and send the invoice with 14-day terms.
5. Stamp each entry with `stripe_invoice_id`, `invoiced_at`, and
   `rate_cents_at_invoice`.

If Stripe creates the invoice and step 5 then fails, those entries still look
unbilled and a retry would bill them twice. Each invoice item therefore carries
an idempotency key derived from the entry id (`ti_<entry_id>`), so Stripe
returns the existing item rather than creating a second one. A retry is safe
wherever the first attempt died.

An admin screen lists unbilled entries per company and triggers this route.
Staff time logging gains a `billable` toggle.

## Environment variables

Added to `.env.local`, which is already gitignored:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_SUB4=price_...
STRIPE_PRICE_SUB20=price_...
```

The two price ids come from recurring prices created in the Stripe dashboard. No
publishable key is needed: Checkout is Stripe-hosted.

None of the four carry the `NEXT_PUBLIC_` prefix, because none are read in the
browser. Only the checkout route resolves a tier to a price id, and the plan
cards show "$150" and "$250" as text rather than deriving them from a price id.
A `NEXT_PUBLIC_` variable is inlined into the client bundle, so the prefix would
publish these ids for no benefit.

`STRIPE_WEBHOOK_SECRET` differs between local testing and production. The local
value comes from `stripe listen`; the production value from the dashboard
webhook endpoint. They are not interchangeable.

`.env.local.example` gains all four with empty values and a comment each.

## Testing

Jest, matching the existing setup and the `createFakeAdminClient` pattern in
`connectionAllowance.test.ts`.

Pure unit tests:

- `companyAccess`: all five states; the day 30 to 31 boundary; `daysLeft`
  arithmetic; missing or garbage values lock rather than open.
- `consultingRate` and rounding: a per-company rate beats the default; minutes to
  cents never drifts.

Route tests with fakes:

- Webhook: each event writes the expected columns; a duplicate event id is a
  no-op; a bad signature returns 400.
- Checkout: a client-supplied price id is rejected; unauthenticated is rejected.
- Guard: an expired company gets 403 from a mutating route, not merely a UI
  redirect.

Manual verification before trusting real money:

```bash
stripe listen --forward-to localhost:3000/api/billing/webhook
stripe trigger checkout.session.completed
```

Card `4242 4242 4242 4242` succeeds. Card `4000 0000 0000 0341` attaches and then
fails, exercising the `past_due` banner.

## Build order

Each step is shippable on its own. The lock works before Stripe exists, because
it reads only `trial_ends_at`.

1. Schema migration
2. `lib/companyAccess.ts` and its tests
3. Banner and hard lock
4. Checkout and billing portal
5. Webhook
6. Consulting invoices

## Out of scope

- Annual billing and discounts
- Proration on tier changes beyond Stripe's default behaviour
- Dunning emails beyond what Stripe sends
- In-app invoice history; the Stripe Billing Portal covers it
- Multi-currency; USD only
