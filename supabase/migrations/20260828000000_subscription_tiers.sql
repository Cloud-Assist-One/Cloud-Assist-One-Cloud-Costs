-- Subscription tiers -----------------------------------------------------
--
-- Each company sits on a tier that caps how many cloud connections it can
-- add, counted across every provider rather than per provider. Existing
-- companies and any new one default to 'free', which admins can change.

alter table public.companies
  add column subscription_tier text not null default 'free'
  check (subscription_tier in ('free', 'subscription_4', 'subscription_20', 'subscription_unlimited'));

-- Self-signup collects these, and they are useful to whoever picks the
-- account up afterwards. Nullable: every profile created before this, and
-- any created by an admin, has none.
alter table public.profiles add column first_name text;
alter table public.profiles add column last_name text;
alter table public.profiles add column phone text;

-- Staff already hold the update policy on companies, so changing a tier
-- needs no new policy. Clients must not be able to raise their own limit,
-- and companies_update_staff already prevents that.
