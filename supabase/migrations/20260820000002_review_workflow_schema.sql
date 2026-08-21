-- Review notes ------------------------------------------------------------

create table public.review_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cost_record_id uuid references public.cost_records (id) on delete set null,
  author_id uuid not null references public.profiles (id) on delete cascade,
  note_text text,
  voice_note_path text,
  created_at timestamptz not null default now(),
  constraint review_notes_has_content check (note_text is not null or voice_note_path is not null)
);

create index review_notes_company_id_idx on public.review_notes (company_id);

alter table public.review_notes enable row level security;

create policy "review_notes_select"
  on public.review_notes for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "review_notes_insert_staff"
  on public.review_notes for insert
  to authenticated
  with check ((select private.is_staff()) and author_id = (select auth.uid()));

create policy "review_notes_delete_staff"
  on public.review_notes for delete
  to authenticated
  using ((select private.is_staff()));

-- Review todos ------------------------------------------------------------

create table public.review_todos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cost_record_id uuid references public.cost_records (id) on delete set null,
  title text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index review_todos_company_id_idx on public.review_todos (company_id);

alter table public.review_todos enable row level security;

create policy "review_todos_select"
  on public.review_todos for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "review_todos_insert_staff"
  on public.review_todos for insert
  to authenticated
  with check ((select private.is_staff()) and created_by = (select auth.uid()));

create policy "review_todos_update_staff"
  on public.review_todos for update
  to authenticated
  using ((select private.is_staff()));

create policy "review_todos_delete_staff"
  on public.review_todos for delete
  to authenticated
  using ((select private.is_staff()));

-- Time entries --------------------------------------------------------------

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  staff_id uuid not null references public.profiles (id) on delete cascade,
  entry_date date not null,
  minutes_spent integer not null check (minutes_spent > 0),
  description text not null,
  created_at timestamptz not null default now()
);

create index time_entries_company_id_idx on public.time_entries (company_id);

alter table public.time_entries enable row level security;

create policy "time_entries_select"
  on public.time_entries for select
  to authenticated
  using ((select private.is_staff()) or company_id = (select private.user_company_id()));

create policy "time_entries_insert_staff"
  on public.time_entries for insert
  to authenticated
  with check ((select private.is_staff()) and staff_id = (select auth.uid()));

create policy "time_entries_update_staff"
  on public.time_entries for update
  to authenticated
  using ((select private.is_staff()));

create policy "time_entries_delete_staff"
  on public.time_entries for delete
  to authenticated
  using ((select private.is_staff()));

-- Storage bucket for voice notes --------------------------------------------
-- Objects are stored under "{company_id}/..." so folder-based RLS can scope them.

insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', false)
on conflict (id) do nothing;

create policy "voice_notes_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'voice-notes'
    and ((select private.is_staff()) or (storage.foldername(name))[1] = (select private.user_company_id())::text)
  );

create policy "voice_notes_insert_staff"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'voice-notes' and (select private.is_staff()));

create policy "voice_notes_delete_staff"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'voice-notes' and (select private.is_staff()));

-- Base table grants --------------------------------------------------------
-- RLS policies are never evaluated without these — see Global Constraints.

grant select, insert, delete on public.review_notes to authenticated;
grant select, insert, update, delete on public.review_notes to service_role;

grant select, insert, update, delete on public.review_todos to authenticated;
grant select, insert, update, delete on public.review_todos to service_role;

grant select, insert on public.time_entries to authenticated;
grant select, insert, update, delete on public.time_entries to service_role;
