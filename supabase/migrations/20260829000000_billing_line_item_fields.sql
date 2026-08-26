-- Richer billing line items ------------------------------------------------
--
-- cost_records held only service/date/cost/account, which is all an
-- aggregated cost API returns. Uploaded provider exports (AWS CUR, Azure
-- usage exports) and Azure's Cost Details report carry far more per line
-- item, so the columns below exist to hold it.
--
-- Every column is nullable on purpose: a row's detail depends on where it
-- came from. A service-level pull fills almost none of these; a CUR upload
-- fills most. Nothing should assume they are present.

alter table public.cost_records
  -- What the charge was for
  add column resource_id text,
  add column resource_group text,
  add column region text,
  add column availability_zone text,
  add column instance_type text,
  add column database_engine text,
  add column meter_category text,
  add column meter_name text,
  add column usage_type text,
  add column operation text,

  -- Who it belongs to. account_id already exists; these name it, and cover
  -- Azure's subscription pair, so reports can show something human-readable.
  add column subscription_id text,
  add column subscription_name text,

  -- How it was bought: OnDemand, Reservation, Spot, SavingsPlan.
  add column purchase_type text,
  add column reservation_id text,
  add column reservation_name text,

  -- How it was priced. Kept as numerics so they can be summed and averaged
  -- rather than only displayed.
  add column quantity numeric,
  add column unit text,
  add column unit_price numeric,
  add column effective_price numeric,
  add column currency text,

  -- usage / purchase / refund / tax, so credits can be told apart from spend.
  add column charge_type text,

  -- Free-form provider tags, jsonb rather than text so individual keys stay
  -- queryable (e.g. tags->>'Billing Code').
  add column tags jsonb;

-- The tag column drives cost-centre reporting, which means filtering by a
-- single key inside the document — the case GIN is for.
create index cost_records_tags_idx on public.cost_records using gin (tags);

-- Grouping and filtering the line-item grid by these is the whole point of
-- collecting them, and both are low cardinality per period.
create index cost_records_period_region_idx on public.cost_records (period_id, region);
create index cost_records_period_resource_idx on public.cost_records (period_id, resource_id);

-- Archived periods are keyed by billing month ---------------------------------
--
-- Archiving twice for the same month used to leave two archived periods for
-- it. Recording the month makes "one archive per billing month" enforceable;
-- it stays null for a period that never received any data.
alter table public.billing_periods add column billing_month date;
