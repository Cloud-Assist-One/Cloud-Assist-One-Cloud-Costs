-- Support requests -----------------------------------------------------------
--
-- Tickets raised from the Support tab. Kept separate from review_notes/todos:
-- those are staff-authored commentary on a billing period, whereas these are
-- client-initiated help requests that are not tied to a period at all.

create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  submitted_by uuid not null references public.profiles (id),
  first_name text not null,
  -- Defaults to the submitter's login address in the UI, but is editable, so
  -- it is stored per request rather than read back from the profile.
  email text not null,
  phone text,
  phone_ext text,
  -- The checkbox selections. An array rather than one row per topic: a request
  -- is always read and displayed whole, never queried by individual topic.
  topics text[] not null default '{}',
  details text,
  created_at timestamptz not null default now()
);

create index support_requests_company_created_idx
  on public.support_requests (company_id, created_at desc);

alter table public.support_requests enable row level security;

-- Same visibility rule as review_notes: staff/admin see everything, a client
-- sees only their own company's requests.
create policy "support_requests_select"
  on public.support_requests for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

-- Anyone with access to the company may raise a request, but only as
-- themselves — submitted_by cannot be spoofed onto another user.
create policy "support_requests_insert"
  on public.support_requests for insert
  to authenticated
  with check (
    ((select private.is_staff()) or company_id = (select private.user_company_id()))
    and submitted_by = (select auth.uid())
  );

grant select, insert on public.support_requests to authenticated;
grant select, insert, update, delete on public.support_requests to service_role;
