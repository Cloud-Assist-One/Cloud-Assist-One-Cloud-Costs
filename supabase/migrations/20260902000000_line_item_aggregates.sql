-- Totals and subtotals for the Line Items tab.
--
-- The grid pages fifty rows at a time, so a sum has to come from the database
-- rather than from what happens to be on screen. These take the same filter
-- arguments the grid does, so the total always describes exactly the rows the
-- grid is showing.
--
-- SECURITY INVOKER, deliberately, and it is the whole safety story here.
-- Called with the user's session these run under the cost_records RLS policy
-- ("is_staff() or company_id = user_company_id()"), so a company can only ever
-- total its own spend. The one other function in this schema,
-- archive_billing_period, is SECURITY DEFINER and called with the service-role
-- client -- copying that pattern here would sum every company's costs and hand
-- the number to whoever asked.

create or replace function public.line_items_summary(
  p_period_id uuid,
  p_cloud_provider text default null,
  p_service_names text[] default null,
  p_search_text text default null,
  p_billing_code text default null,
  p_account_id text default null,
  p_region text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_cost_min numeric default null,
  p_cost_max numeric default null,
  p_exclude_zero_cost boolean default false
)
returns table (row_count bigint, total_cost numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::bigint, coalesce(sum(c.cost), 0)
  from public.cost_records c
  where c.period_id = p_period_id
    and (p_cloud_provider is null or c.cloud_provider = p_cloud_provider)
    and (p_service_names is null or c.service_name = any(p_service_names))
    -- search_text is stored lowercased by its generated column; the caller
    -- lowercases the term to match, as the TypeScript filter does.
    and (p_search_text is null or c.search_text like '%' || p_search_text || '%')
    and (p_billing_code is null or c.billing_code = p_billing_code)
    and (p_account_id is null or c.account_id = p_account_id)
    and (p_region is null or c.region = p_region)
    and (p_date_from is null or c.usage_date >= p_date_from)
    and (p_date_to is null or c.usage_date <= p_date_to)
    and (p_cost_min is null or c.cost >= p_cost_min)
    and (p_cost_max is null or c.cost <= p_cost_max)
    -- Exactly zero, and nothing else. These totals are reconciled against the
    -- provider's own invoice, so a threshold sweeping up fractions of a penny
    -- would move the number away from what AWS reports. Rows costing nothing
    -- contribute nothing, so this is the only trim that leaves the sum intact.
    -- Sub-cent rows are handled in the display: the grid renders them as
    -- "<$0.01" rather than "$0.00".
    and (not p_exclude_zero_cost or c.cost <> 0)
$$;

create or replace function public.line_items_grouped(
  p_period_id uuid,
  p_group_by text,
  p_cloud_provider text default null,
  p_service_names text[] default null,
  p_search_text text default null,
  p_billing_code text default null,
  p_account_id text default null,
  p_region text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_cost_min numeric default null,
  p_cost_max numeric default null,
  p_exclude_zero_cost boolean default false
)
returns table (group_key text, row_count bigint, total_cost numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    -- Whitelisted, never interpolated: p_group_by arrives from the client, and
    -- a column name pasted into dynamic SQL is how an aggregate endpoint turns
    -- into an injection point. An unrecognised value groups everything under
    -- one null key rather than erroring the tab.
    case p_group_by
      when 'service_name' then c.service_name
      when 'billing_code' then c.billing_code
      when 'account_id' then c.account_id
      when 'region' then c.region
      when 'charge_type' then c.charge_type
      when 'cloud_provider' then c.cloud_provider
    end,
    count(*)::bigint,
    coalesce(sum(c.cost), 0)
  from public.cost_records c
  where c.period_id = p_period_id
    and (p_cloud_provider is null or c.cloud_provider = p_cloud_provider)
    and (p_service_names is null or c.service_name = any(p_service_names))
    and (p_search_text is null or c.search_text like '%' || p_search_text || '%')
    and (p_billing_code is null or c.billing_code = p_billing_code)
    and (p_account_id is null or c.account_id = p_account_id)
    and (p_region is null or c.region = p_region)
    and (p_date_from is null or c.usage_date >= p_date_from)
    and (p_date_to is null or c.usage_date <= p_date_to)
    and (p_cost_min is null or c.cost >= p_cost_min)
    and (p_cost_max is null or c.cost <= p_cost_max)
    and (not p_exclude_zero_cost or c.cost <> 0)
  group by 1
  -- Biggest spend first: the point of grouping is to see where the money went.
  order by 3 desc
$$;

revoke execute on function public.line_items_summary from public, anon;
revoke execute on function public.line_items_grouped from public, anon;
grant execute on function public.line_items_summary to authenticated;
grant execute on function public.line_items_grouped to authenticated;
