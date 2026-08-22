-- Billing periods -----------------------------------------------------
-- One review cycle per company; exactly one 'active' at a time.

create table public.billing_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index billing_periods_one_active_idx
  on public.billing_periods (company_id)
  where status = 'active';

create index billing_periods_company_id_idx on public.billing_periods (company_id);

alter table public.billing_periods enable row level security;

create policy "billing_periods_select"
  on public.billing_periods for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

grant select on public.billing_periods to authenticated;
grant select, insert, update, delete on public.billing_periods to service_role;

-- Auto-stamp period_id on insert ------------------------------------------
-- Runs before NOT NULL is checked, so attaching this trigger in the same
-- migration as the NOT NULL constraint below is what makes this migration
-- safe to apply at any time relative to application code deploys: every
-- insert (from old app code or new) gets a correct period_id unconditionally.

create or replace function private.stamp_active_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
begin
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

-- New companies get an initial active period automatically ----------------

create or replace function private.handle_new_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.billing_periods (company_id, status) values (new.id, 'active');
  return new;
end;
$$;

create trigger on_company_created
  after insert on public.companies
  for each row execute function private.handle_new_company();

-- Backfill: every existing company gets one active period -----------------
-- (every company, not just ones with existing data -- a company with zero
-- uploads so far still needs an active period to write into later)

insert into public.billing_periods (company_id, status)
select id, 'active' from public.companies;

-- Add period_id to existing tables, nullable first -------------------------

alter table public.cost_records add column period_id uuid references public.billing_periods (id);
alter table public.uploaded_files add column period_id uuid references public.billing_periods (id);
alter table public.review_notes add column period_id uuid references public.billing_periods (id);
alter table public.review_todos add column period_id uuid references public.billing_periods (id);
alter table public.time_entries add column period_id uuid references public.billing_periods (id);

-- Backfill existing rows to point at their company's active period --------

update public.cost_records cr
set period_id = bp.id
from public.billing_periods bp
where bp.company_id = cr.company_id and bp.status = 'active';

update public.uploaded_files uf
set period_id = bp.id
from public.billing_periods bp
where bp.company_id = uf.company_id and bp.status = 'active';

update public.review_notes rn
set period_id = bp.id
from public.billing_periods bp
where bp.company_id = rn.company_id and bp.status = 'active';

update public.review_todos rt
set period_id = bp.id
from public.billing_periods bp
where bp.company_id = rt.company_id and bp.status = 'active';

update public.time_entries te
set period_id = bp.id
from public.billing_periods bp
where bp.company_id = te.company_id and bp.status = 'active';

-- Now safe to enforce NOT NULL and attach the auto-stamp trigger -----------

alter table public.cost_records alter column period_id set not null;
alter table public.uploaded_files alter column period_id set not null;
alter table public.review_notes alter column period_id set not null;
alter table public.review_todos alter column period_id set not null;
alter table public.time_entries alter column period_id set not null;

create index cost_records_period_id_idx on public.cost_records (period_id);
create index uploaded_files_period_id_idx on public.uploaded_files (period_id);
create index review_notes_period_id_idx on public.review_notes (period_id);
create index review_todos_period_id_idx on public.review_todos (period_id);
create index time_entries_period_id_idx on public.time_entries (period_id);

create trigger stamp_period_cost_records
  before insert on public.cost_records
  for each row execute function private.stamp_active_period();

create trigger stamp_period_uploaded_files
  before insert on public.uploaded_files
  for each row execute function private.stamp_active_period();

create trigger stamp_period_review_notes
  before insert on public.review_notes
  for each row execute function private.stamp_active_period();

create trigger stamp_period_review_todos
  before insert on public.review_todos
  for each row execute function private.stamp_active_period();

create trigger stamp_period_time_entries
  before insert on public.time_entries
  for each row execute function private.stamp_active_period();

-- Archive action (atomic) ---------------------------------------------------

create or replace function public.archive_billing_period(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_period_id uuid;
begin
  update public.billing_periods
  set status = 'archived', archived_at = now()
  where company_id = p_company_id and status = 'active';

  if not found then
    raise exception 'No active billing period found for company %', p_company_id;
  end if;

  insert into public.billing_periods (company_id, status)
  values (p_company_id, 'active')
  returning id into v_new_period_id;

  return v_new_period_id;
end;
$$;

revoke execute on function public.archive_billing_period(uuid) from public, anon, authenticated;
grant execute on function public.archive_billing_period(uuid) to service_role;

-- 12-month trend view --------------------------------------------------------
-- security_invoker makes this inherit cost_records' own RLS at query time,
-- rather than needing a duplicate policy set on the view itself.

create view public.monthly_cost_by_provider
with (security_invoker = true) as
select
  company_id,
  date_trunc('month', usage_date)::date as month,
  cloud_provider,
  sum(cost) as total
from public.cost_records
where usage_date >= (current_date - interval '12 months')
group by company_id, date_trunc('month', usage_date), cloud_provider;

grant select on public.monthly_cost_by_provider to authenticated;
grant select on public.monthly_cost_by_provider to service_role;
