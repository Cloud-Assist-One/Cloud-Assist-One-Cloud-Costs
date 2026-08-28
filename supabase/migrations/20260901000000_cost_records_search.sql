-- Searching and billing-code filtering for the Line Items tab.
--
-- Sized for what is coming rather than what is here: cost_records holds a few
-- thousand rows today, where any approach would feel instant, but Detail Pull
-- (CUR ingestion) landed this week and one month of real CUR for a single
-- account runs orders of magnitude larger. An ILIKE across twenty-odd columns
-- would work now and collapse then.
create extension if not exists pg_trgm;

-- Every column worth searching, flattened into one lowercased haystack.
--
-- Generated rather than trigger-maintained so it can never drift from the
-- columns it summarises, and STORED so the trigram index below has something
-- to index. concat_ws is deliberately not used: PostgreSQL marks it STABLE
-- rather than IMMUTABLE, which a generated column rejects.
alter table public.cost_records
  add column search_text text generated always as (
    lower(
      coalesce(service_name, '') || ' ' ||
      coalesce(resource_id, '') || ' ' ||
      coalesce(region, '') || ' ' ||
      coalesce(instance_type, '') || ' ' ||
      coalesce(meter_category, '') || ' ' ||
      coalesce(meter_name, '') || ' ' ||
      coalesce(usage_type, '') || ' ' ||
      coalesce(operation, '') || ' ' ||
      coalesce(subscription_name, '') || ' ' ||
      coalesce(charge_type, '') || ' ' ||
      coalesce(account_id, '')
    )
  ) stored;

-- The billing-code tag under any spelling.
--
-- Tag keys are typed by hand in each cloud console, so the same tag arrives as
-- "Billing Code", "billing_code", "BillingCode", "billing-code". Comparing on
-- letters and digits alone treats them as one tag -- the same rule
-- isBillingCodeTag applies in lib/billingCode.ts.
--
-- The rule is stated twice, once per language, because filtering happens in
-- Postgres and display happens in TypeScript; neither can call the other. The
-- two must be changed together, which is why each names the other.
create or replace function private.billing_code_of(p_tags jsonb)
returns text
language sql
immutable
strict
as $$
  select case when jsonb_typeof(p_tags) = 'object' then (
    select tag.value
    from jsonb_each_text(p_tags) as tag
    where regexp_replace(lower(tag.key), '[^a-z0-9]', '', 'g') = 'billingcode'
    -- Ordered so a resource tagged under two spellings resolves the same way
    -- every time. formatTags still displays every match; this column, being a
    -- single value, has to pick one.
    order by tag.key
    limit 1
  ) end
$$;

alter table public.cost_records
  add column billing_code text generated always as (private.billing_code_of(tags)) stored;

create index cost_records_search_text_trgm_idx
  on public.cost_records using gin (search_text gin_trgm_ops);

create index cost_records_period_billing_code_idx
  on public.cost_records (period_id, billing_code);
