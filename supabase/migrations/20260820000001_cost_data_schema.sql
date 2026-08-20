-- Uploaded files ----------------------------------------------------------

create table public.uploaded_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cloud_provider text not null check (cloud_provider in ('aws', 'azure')),
  filename text not null,
  storage_path text not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'error')),
  error_message text,
  row_count integer,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index uploaded_files_company_id_idx on public.uploaded_files (company_id);

alter table public.uploaded_files enable row level security;

create policy "uploaded_files_select"
  on public.uploaded_files for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "uploaded_files_insert"
  on public.uploaded_files for insert
  to authenticated
  with check ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "uploaded_files_update_staff"
  on public.uploaded_files for update
  to authenticated
  using ((select private.is_staff()));

create policy "uploaded_files_delete_staff"
  on public.uploaded_files for delete
  to authenticated
  using ((select private.is_staff()));

-- Cost records --------------------------------------------------------------

create table public.cost_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cloud_provider text not null check (cloud_provider in ('aws', 'azure')),
  service_name text not null,
  usage_date date not null,
  cost numeric not null,
  account_id text,
  source_file_id uuid not null references public.uploaded_files (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index cost_records_company_provider_date_idx
  on public.cost_records (company_id, cloud_provider, usage_date);

alter table public.cost_records enable row level security;

create policy "cost_records_select"
  on public.cost_records for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "cost_records_write_staff"
  on public.cost_records for insert
  to authenticated
  with check ((select private.is_staff()));

create policy "cost_records_update_staff"
  on public.cost_records for update
  to authenticated
  using ((select private.is_staff()));

create policy "cost_records_delete_staff"
  on public.cost_records for delete
  to authenticated
  using ((select private.is_staff()));

-- Storage bucket --------------------------------------------------------------
-- Objects are stored under "{company_id}/..." so folder-based RLS can scope them.

insert into storage.buckets (id, name, public)
values ('billing-files', 'billing-files', false)
on conflict (id) do nothing;

create policy "billing_files_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'billing-files'
    and ((select private.is_staff()) or (storage.foldername(name))[1] = (select private.user_company_id())::text)
  );

create policy "billing_files_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'billing-files'
    and ((select private.is_staff()) or (storage.foldername(name))[1] = (select private.user_company_id())::text)
  );

create policy "billing_files_delete_staff"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'billing-files' and (select private.is_staff()));

-- Base table grants --------------------------------------------------------
-- RLS policies are never evaluated without these — see Global Constraints.

grant select, insert, update, delete on public.uploaded_files to authenticated;
grant select, insert, update, delete on public.uploaded_files to service_role;

grant select, insert, update, delete on public.cost_records to authenticated;
grant select, insert, update, delete on public.cost_records to service_role;
