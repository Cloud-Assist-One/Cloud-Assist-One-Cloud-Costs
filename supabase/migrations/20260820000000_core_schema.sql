-- Private schema for internal helper functions (not exposed via the API)
create schema if not exists private;

-- Companies ------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.companies enable row level security;

-- Profiles -------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  email text not null,
  role text not null default 'client' check (role in ('client', 'staff')),
  created_at timestamptz not null default now()
);

create index profiles_company_id_idx on public.profiles (company_id);

alter table public.profiles enable row level security;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Multi-tenancy helpers --------------------------------------------------

create or replace function private.is_staff()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'staff'
  );
$$;

create or replace function private.user_company_id()
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select company_id from public.profiles where id = (select auth.uid());
$$;

revoke execute on function private.is_staff() from public, anon;
grant execute on function private.is_staff() to authenticated;
revoke execute on function private.user_company_id() from public, anon;
grant execute on function private.user_company_id() to authenticated;

-- RLS policies -----------------------------------------------------------

create policy "companies_select"
  on public.companies for select
  to authenticated
  using ((select private.is_staff()) or id = (select private.user_company_id()));

create policy "companies_insert_staff"
  on public.companies for insert
  to authenticated
  with check ((select private.is_staff()));

create policy "companies_update_staff"
  on public.companies for update
  to authenticated
  using ((select private.is_staff()));

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_select_staff"
  on public.profiles for select
  to authenticated
  using ((select private.is_staff()));

create policy "profiles_update_staff"
  on public.profiles for update
  to authenticated
  using ((select private.is_staff()));

-- Base table grants --------------------------------------------------------
-- RLS policies are never evaluated without these — see Global Constraints.

grant select, insert, update on public.companies to authenticated;
grant select, insert, update, delete on public.companies to service_role;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
