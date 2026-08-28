-- A CUR delivers every tag inside one JSON map and keeps the full column name
-- as the key -- "resourceTags/user:Billing Code" rather than "Billing Code".
-- Cost Explorer pulls and hand uploads carry the bare name. Without stripping
-- the prefix the billing code silently disappeared the moment CUR data
-- replaced a Cost Explorer pull: 18 tagged CUR rows resolved to null.
--
-- Mirrors isBillingCodeTag in lib/billingCode.ts; change the two together.
create or replace function private.billing_code_of(p_tags jsonb)
returns text
language sql
immutable
strict
as $$
  select case when jsonb_typeof(p_tags) = 'object' then (
    select tag.value
    from jsonb_each_text(p_tags) as tag
    where regexp_replace(
            regexp_replace(lower(tag.key), '^(resource[_ -]?tags[/_])?user[:_]', ''),
            '[^a-z0-9]', '', 'g'
          ) = 'billingcode'
    order by tag.key
    limit 1
  ) end
$$;

-- The generated column caches the old result, so every row has to be
-- recomputed. Dropping and re-adding is what forces that; a plain UPDATE
-- cannot touch a generated column.
alter table public.cost_records drop column billing_code;

alter table public.cost_records
  add column billing_code text generated always as (private.billing_code_of(tags)) stored;

create index cost_records_period_billing_code_idx
  on public.cost_records (period_id, billing_code);
