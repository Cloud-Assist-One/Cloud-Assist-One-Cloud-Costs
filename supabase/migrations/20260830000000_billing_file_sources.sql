-- A bucket or container a company's cost exports land in, so the portal can
-- pull them instead of someone downloading and re-uploading by hand.
create table public.billing_file_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  credential_id uuid not null references public.cloud_provider_credentials (id) on delete cascade,
  cloud_provider text not null check (cloud_provider in ('aws', 'azure', 'gcp', 'snowflake')),
  -- S3 bucket name, or Azure "account/container".
  container text not null,
  prefix text not null default '',
  label text not null,
  enabled boolean not null default true,
  schedule_enabled boolean not null default false,
  last_pulled_at timestamptz,
  last_pull_summary jsonb,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create index billing_file_sources_company_id_idx
  on public.billing_file_sources (company_id);

-- RLS on with no authenticated policies, matching cloud_provider_credentials:
-- every read and write goes through a route using createAdminClient().
alter table public.billing_file_sources enable row level security;
grant select, insert, update, delete on public.billing_file_sources to service_role;

-- Which bucket object produced a file row, so a re-pull can tell what it
-- already has.
alter table public.uploaded_files
  add column source_id uuid references public.billing_file_sources (id) on delete set null,
  add column source_object_key text,
  add column source_object_etag text;

-- The dedupe mechanism. The unit is the RUN, not the object: source_object_key
-- holds the manifest key (AWS) or the snapshot blob key (Azure), so a 40-part
-- CUR run is one row. Key plus etag means a provider rewriting an export
-- mid-month counts as new content rather than being skipped. Being an index
-- rather than a select-then-decide check is what makes double-processing
-- impossible under a race with a future scheduled pull.
create unique index uploaded_files_source_object_idx
  on public.uploaded_files (source_id, source_object_key, source_object_etag)
  where source_id is not null;

-- One archived period per billing month was previously enforced only in
-- app/api/periods/archive/route.ts. This feature adds a second writer of
-- archived periods, so the rule moves into the database.
--
-- This block FAILS LOUDLY if the rule is already violated, rather than
-- half-applying: resolve the duplicates by hand, then re-run.
do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes from (
    select company_id, billing_month
    from public.billing_periods
    where status = 'archived' and billing_month is not null
    group by company_id, billing_month
    having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise exception
      'Cannot add the one-archive-per-month index: % company/month pair(s) already have duplicate archived periods. Resolve them, then re-run this migration.', v_dupes;
  end if;
end $$;

create unique index billing_periods_one_archive_per_month_idx
  on public.billing_periods (company_id, billing_month)
  where status = 'archived' and billing_month is not null;

-- Let a caller choose the period a row belongs to.
--
-- private.stamp_active_period() previously did `new.period_id := <active>`
-- unconditionally, overwriting anything the insert supplied. That is correct
-- as a safety net for code that knows nothing about periods -- which is every
-- caller today, none of which sets period_id -- but it makes importing a
-- historical month impossible: the rows would land in the active period no
-- matter which period they were meant for.
--
-- Stamping only when the caller left it null keeps the safety net exactly as
-- it was for every existing path, while letting Pull Billing target an
-- archived period deliberately. Attached to cost_records, uploaded_files,
-- review_notes, review_todos and time_entries, so all five are covered by
-- replacing the one function.
create or replace function private.stamp_active_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
begin
  if new.period_id is not null then
    return new;
  end if;

  select id into v_period_id
  from public.billing_periods
  where company_id = new.company_id and status = 'active';

  if v_period_id is null then
    raise exception 'No active billing period found for company %', new.company_id;
  end if;

  new.period_id := v_period_id;
  return new;
end;
$$;
