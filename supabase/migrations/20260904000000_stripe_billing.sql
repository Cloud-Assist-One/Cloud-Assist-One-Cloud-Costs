-- Stripe billing --------------------------------------------------------
--
-- A company's subscription_tier has, until now, only ever been set by a
-- staff member picking it from a dropdown. These three columns are what a
-- client's own payment does instead: the Stripe customer this company maps
-- to (so a repeat checkout reuses it instead of splitting payment history
-- across duplicates), the subscription currently backing the tier, and that
-- subscription's own status for display.
--
-- Written only by the service-role client from the checkout/portal routes
-- and the Stripe webhook -- companies_update_staff still blocks a client
-- from touching them (or the tier) directly, same as before this migration.
-- No RLS change is needed for reading them: companies_select already lets a
-- company see its own row, and none of the three is sensitive on its own --
-- a Stripe customer or subscription id is meaningless without the secret key
-- that authorizes acting on it.

alter table public.companies
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column subscription_status text;
