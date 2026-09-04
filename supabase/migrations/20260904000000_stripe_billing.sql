-- Stripe billing ---------------------------------------------------------
--
-- The trial is tracked here, not in Stripe: signup takes no card, so Stripe
-- learns about a company only when it pays. The four Stripe columns have
-- exactly one writer, the webhook handler running as the service role.

-- No default here: ADD COLUMN ... DEFAULT <expr> would apply that default to
-- every pre-existing row, including companies already on a paid tier, not
-- just to new inserts. The default is added separately below, after the
-- backfill, so it only ever applies going forward.
alter table public.companies
  add column trial_ends_at timestamptz,
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

-- New signups get their 30 days from here on. Each insert evaluates now() at
-- insert time, so this only ever affects rows created after this migration.
alter table public.companies
  alter column trial_ends_at set default now() + interval '30 days';

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

-- RLS on with no policies, plus a grant scoped to exactly what the webhook
-- handler does: insert the claim row, and delete it again if processing
-- fails after the insert so a retry can reclaim the same event id. No
-- select or update, and no grant to authenticated -- RLS policies are never
-- evaluated without a base-table grant (see Global Constraints), so the
-- combination of RLS-with-no-policies and a service_role-only grant is what
-- actually makes this table service-role only.
alter table public.stripe_events enable row level security;

grant insert, delete on public.stripe_events to service_role;

-- No new policies on companies. companies_update_staff is the only update
-- policy, so a client cannot write its own tier or trial date, and
-- companies_select already allows id = private.user_company_id(), which is
-- what the trial banner reads.
