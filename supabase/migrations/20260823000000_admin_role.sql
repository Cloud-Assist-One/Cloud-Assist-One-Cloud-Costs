-- Admin role: a superset of staff. private.is_staff() now also returns true
-- for 'admin', so every existing staff-gated RLS policy and app-level
-- requireStaff() check automatically extends to admins without touching
-- their definitions. Admin-only actions (delete a company and all its data,
-- create other admin accounts) are gated separately by private.is_admin()
-- / a new requireAdmin() app guard, layered on top in application code.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('client', 'staff', 'admin'));

create or replace function private.is_staff()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('staff', 'admin')
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- Promote the account requested by the product owner to the new role.
update public.profiles set role = 'admin' where email = 'mgolino@outlook.com';
