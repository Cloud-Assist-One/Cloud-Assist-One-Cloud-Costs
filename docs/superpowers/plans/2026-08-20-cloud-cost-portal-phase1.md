# Cloud Cost Review Portal — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working slice of the cloud cost review portal: login, AWS billing file upload, and AWS cost reporting (charts + breakdown). This is the first of three phases — Phase 2 adds Azure + comparison, Phase 3 adds the notes/todos/time-tracking review workflow and the staff Admin tab.

**Architecture:** Next.js App Router + Supabase (Postgres + Auth + Storage), deployed on Vercel — the same stack and conventions proven on the Cloud Assist One AI training portal. All client-facing reads/writes go through the anon key and Row Level Security scoped by `company_id`; staff bypass that scope via a `role = 'staff'` check.

**Tech Stack:** Next.js 16, React 19, `@supabase/supabase-js`, `@supabase/ssr`, `xlsx` (Excel parsing), `recharts` (charts), Supabase Postgres/Auth/Storage, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-19-cloud-cost-portal-phase1-design.md`

## Global Constraints

- This is a brand-new project in its own repository, its own Supabase project, and its own Vercel project.
- **Every migration that creates a table MUST include explicit `grant select, insert, update, delete on public.<table> to authenticated;` and `to service_role;` statements in the same migration.** Supabase does not grant these by default beyond `REFERENCES`/`TRIGGER`/`TRUNCATE`, and RLS policies are never evaluated without the base GRANT — this exact gap silently broke the entire training portal until a live browser test caught it. Grant first, narrow with RLS second.
- No public self-signup. In this phase there is no Admin UI yet, so the first company and first users are created by hand (Task 12) — the Admin UI arrives in Phase 3.
- Follow existing project conventions established on the training portal: CSS Modules per component, `@/*` path alias, tests co-located as `Component.test.tsx`, functional components with hooks, 2-space indentation, ES modules, `cancelled`-flag guarded `useEffect` for data loading.
- This Next.js version renames `middleware.ts` to `proxy.ts` (exported function `proxy`, not `middleware`) — do not create a `middleware.ts` file.
- Route Handler dynamic params are async (`await params`).
- `jest.config.mjs` must include the `moduleNameMapper` for `@/*` inside `jest.mock()` calls from the start — `next/jest` does not resolve this on its own; this was a lesson learned partway through the training portal, bake it in from day one here.
- All Supabase env vars are trimmed on read (`(process.env.X ?? '').trim()`) — a lesson learned the hard way on the training portal's Vercel deployment.
- The `cost_records` table's `cloud_provider` column and every later query already handle `'aws'` and `'azure'` interchangeably, even though this phase's UI only ever passes `'aws'` — Phase 2 adds the Azure tab with zero schema or component changes, just new wiring in the app shell.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `jest.config.mjs`, `jest.setup.ts`, `.env.local.example`
- Create: `app/layout.tsx`, `app/globals.css`, `app/page.tsx` (placeholder — Task 11 replaces this entirely)
- Create: `__tests__/sanity.test.ts`

**Interfaces:**
- Produces: a working `npm run dev` / `npm run build` / `npm test` / `npm run lint` pipeline every later task builds on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "cloud-cost-portal",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "jest"
  },
  "dependencies": {
    "next": "16.3.1",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "@supabase/supabase-js": "^2.112.3",
    "@supabase/ssr": "^0.12.4",
    "xlsx": "^0.18.5",
    "recharts": "^2.15.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^7.0.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.1",
    "jest": "^30.4.2",
    "jest-environment-jsdom": "^30.4.1",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules", "__tests__", "**/*.test.ts", "**/*.test.tsx"]
}
```

- [ ] **Step 3: Write `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
```

- [ ] **Step 4: Write `eslint.config.mjs`**

```js
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
```

- [ ] **Step 5: Write `jest.config.mjs` and `jest.setup.ts`**

`jest.config.mjs`:
```js
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};

export default createJestConfig(config);
```

`jest.setup.ts`:
```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 6: Write `.env.local.example`**

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

- [ ] **Step 7: Write the base app shell files**

`app/globals.css`:
```css
:root {
  --color-bg: #ffffff;
  --color-bg-alt: #f3f6fa;
  --color-fg: #0f2540;
  --color-border: #dce3ec;
  --color-accent: #2258d3;
  --color-muted: #64748b;
  --radius-pill: 999px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: var(--color-bg);
  color: var(--color-fg);
}

a {
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

`app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cloud Assist One — Cost Review Portal',
  description: 'AWS and Azure billing review for Cloud Assist One clients.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx` (placeholder — Task 11 replaces this file entirely):
```tsx
export default function Home() {
  return <p>Cloud Cost Review Portal — under construction.</p>;
}
```

`__tests__/sanity.test.ts`:
```ts
describe('sanity', () => {
  it('runs', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 8: Install dependencies and verify the pipeline**

Run: `npm install`
Run: `npx tsc --noEmit` — expect no errors.
Run: `npm test` — expect 1 test suite, 1 test, passing.
Run: `npm run lint` — expect no errors.
Run: `npm run build` — expect a successful production build.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts eslint.config.mjs jest.config.mjs jest.setup.ts .env.local.example app __tests__
git commit -m "Scaffold the Next.js project"
```

---

## Task 2: Supabase client helpers, shared types, and environment config

**Files:**
- Create: `lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`
- Create: `lib/types.ts`
- Modify: `.env.local` (gitignored — not committed)

**Interfaces:**
- Produces: `createClient()` (browser, from `lib/supabase/client.ts`), `createClient()` (server/async, from `lib/supabase/server.ts`), `createAdminClient()` (from `lib/supabase/admin.ts`), and the shared types `Company`, `Profile`, `ProfileRole`, `CloudProvider`, `UploadStatus`, `UploadedFile`, `CostRecord` from `lib/types.ts` — every later task in this phase imports one or more of these. (`ReviewNote`, `ReviewTodo`, `TimeEntry`, `TodoStatus` are added in Phase 3, when the tables they describe are created — do not add them now.)

- [ ] **Step 1: Write the shared types**

`lib/types.ts`:
```ts
export type ProfileRole = 'client' | 'staff';
export type CloudProvider = 'aws' | 'azure';
export type UploadStatus = 'processing' | 'processed' | 'error';

export interface Company {
  id: string;
  name: string;
  created_at: string;
}

export interface Profile {
  id: string;
  company_id: string | null;
  email: string;
  role: ProfileRole;
  created_at: string;
}

export interface UploadedFile {
  id: string;
  company_id: string;
  cloud_provider: CloudProvider;
  filename: string;
  storage_path: string;
  status: UploadStatus;
  error_message: string | null;
  row_count: number | null;
  uploaded_by: string;
  created_at: string;
}

export interface CostRecord {
  id: string;
  company_id: string;
  cloud_provider: CloudProvider;
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;
  source_file_id: string;
  created_at: string;
}
```

- [ ] **Step 2: Write the browser Supabase client**

`lib/supabase/client.ts`:
```ts
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  );
}
```

- [ ] **Step 3: Write the server Supabase client**

`lib/supabase/server.ts`:
```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called during a Server Component render, which can't set
            // cookies. proxy.ts refreshes the session on the next request.
          }
        },
      },
    }
  );
}
```

- [ ] **Step 4: Write the admin (service-role) Supabase client**

`lib/supabase/admin.ts`:
```ts
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export function createAdminClient() {
  return createSupabaseClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
```

These four files are thin wrappers with no branching logic — no dedicated unit test, same reasoning as the training portal.

- [ ] **Step 5: Create the Supabase project and write `.env.local`**

If a Supabase project for this app doesn't exist yet, call `mcp__supabase__create_project` (or ask the controller to create one) before continuing. Once it exists, run `mcp__supabase__get_project_url` and `mcp__supabase__get_publishable_keys` for it, and write into `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=<value from get_project_url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<value from get_publishable_keys>
SUPABASE_SERVICE_ROLE_KEY=
```

Leave `SUPABASE_SERVICE_ROLE_KEY` blank — it's a manual step from the Supabase dashboard (Project Settings → API → service_role secret), same as the training portal.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit` — expect no errors.

```bash
git add lib/supabase lib/types.ts
git commit -m "Add Supabase client helpers and shared types"
```

---

## Task 3: Database migration — core schema (companies, profiles, multi-tenancy helpers)

**Files:**
- Create: `supabase/migrations/20260820000000_core_schema.sql`

**Interfaces:**
- Produces: tables `public.companies`, `public.profiles`; helpers `private.is_staff()`, `private.user_company_id()` — every later migration and every RLS policy in this project depends on these two helper functions.

- [ ] **Step 1: Write the migration file**

`supabase/migrations/20260820000000_core_schema.sql`:
```sql
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
```

- [ ] **Step 2: Apply the migration**

Call `mcp__supabase__apply_migration` with the project's `project_id`, `name: "core_schema"`, and `query` set to the full SQL above.

- [ ] **Step 3: Verify**

Call `mcp__supabase__get_advisors` with `type: "security"` — expect no new warnings referencing `companies` or `profiles`.

Call `mcp__supabase__execute_sql` with:
```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('companies', 'profiles')
  and grantee in ('authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```
Confirm `authenticated` has `SELECT`/`INSERT`/`UPDATE` on `companies` and `SELECT`/`UPDATE` on `profiles`; `service_role` has full CRUD on both. **Do not proceed to Task 4 until this is confirmed** — this is the exact gap that broke the training portal.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260820000000_core_schema.sql
git commit -m "Add core schema: companies, profiles, multi-tenancy RLS helpers"
```

---

## Task 4: Database migration — AWS cost data schema

**Files:**
- Create: `supabase/migrations/20260820000001_cost_data_schema.sql`

**Interfaces:**
- Produces: tables `public.uploaded_files`, `public.cost_records`; storage bucket `billing-files`. (Phase 3 adds `review_notes`, `review_todos`, `time_entries`, and the `voice-notes` bucket in its own migration — do not add them now.)

- [ ] **Step 1: Write the migration file**

`supabase/migrations/20260820000001_cost_data_schema.sql`:
```sql
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
```

- [ ] **Step 2: Apply the migration**

Call `mcp__supabase__apply_migration` with `name: "cost_data_schema"` and the full SQL above.

- [ ] **Step 3: Verify**

Call `mcp__supabase__get_advisors` with `type: "security"` — expect no new warnings.

Call `mcp__supabase__list_tables` with `schemas: ["public"]` — confirm `uploaded_files` and `cost_records` are listed with `rls_enabled: true`.

Call `mcp__supabase__execute_sql` with:
```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('uploaded_files', 'cost_records')
  and grantee in ('authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```
Confirm both tables show the grants specified in Step 1 for both roles. **Do not proceed to any later task until this is confirmed.**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260820000001_cost_data_schema.sql
git commit -m "Add AWS/Azure-ready cost data schema: uploaded files, cost records"
```

---

## Task 5: Cost file parser

**Files:**
- Create: `lib/parseCostFile.ts`
- Create: `lib/parseCostFile.test.ts`

**Interfaces:**
- Produces: `parseCostFile(buffer: ArrayBuffer | Buffer): ParseResult`, `ParsedCostRow`, `ParseResult` — consumed by the upload API route in Task 8.

Header matching is intentionally alias-based (case-insensitive, matching common column names like "Service"/"Service Name", "Date"/"Usage Date"/"Start Date", "Cost"/"Amount"/"Blended Cost") rather than hardcoded to one exact schema, since the precise AWS Cost Explorer column names can vary by how a customer configures their export. Refine the alias lists once real sample files are available.

- [ ] **Step 1: Write the failing tests**

`lib/parseCostFile.test.ts`:
```ts
import * as XLSX from 'xlsx';
import { parseCostFile } from './parseCostFile';

function buildWorkbookBuffer(rows: (string | number)[][]): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

describe('parseCostFile', () => {
  it('parses valid rows with a Service/Date/Cost header', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost'],
      ['Amazon EC2', '2026-07-01', 12.5],
      ['Amazon S3', '2026-07-02', 3.25],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null },
      { service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 3.25, account_id: null },
    ]);
  });

  it('recognizes alias headers and an account column', () => {
    const buffer = buildWorkbookBuffer([
      ['Service Name', 'Usage Date', 'Blended Cost', 'Linked Account'],
      ['Azure App Service', '2026-07-03', '$45.10', '1234-5678'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Azure App Service', usage_date: '2026-07-03', cost: 45.1, account_id: '1234-5678' },
    ]);
  });

  it('reports an error and returns no rows when required columns are missing', () => {
    const buffer = buildWorkbookBuffer([
      ['Something', 'Else'],
      ['a', 'b'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([]);
    expect(result.errors).toContain('Could not find a "Service" column.');
    expect(result.errors).toContain('Could not find a "Date" column.');
    expect(result.errors).toContain('Could not find a "Cost" column.');
  });

  it('reports an error for an empty file', () => {
    const buffer = buildWorkbookBuffer([]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(['The file is empty.']);
  });

  it('skips unparseable rows but keeps valid ones, reporting the row number', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost'],
      ['Amazon EC2', '2026-07-01', 12.5],
      ['Amazon S3', 'not-a-date', 3.25],
      ['Amazon RDS', '2026-07-04', 'not-a-number'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null },
    ]);
    expect(result.errors).toEqual([
      'Row 3: could not parse service/date/cost.',
      'Row 4: could not parse service/date/cost.',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/parseCostFile.test.ts`
Expected: FAIL — `Cannot find module './parseCostFile'`.

- [ ] **Step 3: Write the parser**

`lib/parseCostFile.ts`:
```ts
import * as XLSX from 'xlsx';

export interface ParsedCostRow {
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;
}

export interface ParseResult {
  rows: ParsedCostRow[];
  errors: string[];
}

const SERVICE_HEADER_ALIASES = ['service', 'service name'];
const DATE_HEADER_ALIASES = ['date', 'usage date', 'start date'];
const COST_HEADER_ALIASES = ['cost', 'amount', 'blended cost', 'unblended cost', 'total cost'];
const ACCOUNT_HEADER_ALIASES = ['account id', 'linked account', 'subscription id', 'subscription name'];

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function findColumnIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

function parseCostValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,]/g, '').trim();
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function parseCostFile(buffer: ArrayBuffer | Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], errors: ['The file has no sheets.'] };
  }

  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });

  if (data.length === 0) {
    return { rows: [], errors: ['The file is empty.'] };
  }

  const headers = (data[0] as unknown[]).map((h) => String(h ?? ''));
  const serviceIdx = findColumnIndex(headers, SERVICE_HEADER_ALIASES);
  const dateIdx = findColumnIndex(headers, DATE_HEADER_ALIASES);
  const costIdx = findColumnIndex(headers, COST_HEADER_ALIASES);
  const accountIdx = findColumnIndex(headers, ACCOUNT_HEADER_ALIASES);

  const errors: string[] = [];
  if (serviceIdx === -1) errors.push('Could not find a "Service" column.');
  if (dateIdx === -1) errors.push('Could not find a "Date" column.');
  if (costIdx === -1) errors.push('Could not find a "Cost" column.');

  if (errors.length > 0) {
    return { rows: [], errors };
  }

  const rows: ParsedCostRow[] = [];
  for (let i = 1; i < data.length; i += 1) {
    const rowData = data[i] as unknown[] | undefined;
    if (!rowData || rowData.length === 0) continue;

    const serviceName = String(rowData[serviceIdx] ?? '').trim();
    const usageDate = parseDateValue(rowData[dateIdx]);
    const cost = parseCostValue(rowData[costIdx]);
    const accountId = accountIdx !== -1 ? String(rowData[accountIdx] ?? '').trim() || null : null;

    if (!serviceName || !usageDate || cost === null) {
      errors.push(`Row ${i + 1}: could not parse service/date/cost.`);
      continue;
    }

    rows.push({ service_name: serviceName, usage_date: usageDate, cost, account_id: accountId });
  }

  return { rows, errors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/parseCostFile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/parseCostFile.ts lib/parseCostFile.test.ts
git commit -m "Add AWS/Azure cost file parser"
```

---

## Task 6: Report aggregation and date-range utilities

**Files:**
- Create: `lib/reportAggregation.ts`
- Create: `lib/reportAggregation.test.ts`
- Create: `lib/dateRange.ts`
- Create: `lib/dateRange.test.ts`

**Interfaces:**
- Produces: `aggregateByDate`, `aggregateByService`, `totalCost` (from `lib/reportAggregation.ts`); `computeDateRange`, `shiftReferenceDate`, `Granularity` (from `lib/dateRange.ts`) — consumed by `CostReportTab` (Task 10) and its `DateRangePicker` (also Task 10). Phase 2's Compare tab reuses `totalCost` and this same date-range module without any changes here.

- [ ] **Step 1: Write the failing tests for aggregation**

`lib/reportAggregation.test.ts`:
```ts
import { aggregateByDate, aggregateByService, totalCost } from './reportAggregation';

const records = [
  { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
  { service_name: 'Amazon EC2', usage_date: '2026-07-02', cost: 5 },
  { service_name: 'Amazon S3', usage_date: '2026-07-01', cost: 2 },
];

describe('aggregateByDate', () => {
  it('sums cost per date and sorts ascending', () => {
    expect(aggregateByDate(records)).toEqual([
      { date: '2026-07-01', total: 12 },
      { date: '2026-07-02', total: 5 },
    ]);
  });

  it('returns an empty array for no records', () => {
    expect(aggregateByDate([])).toEqual([]);
  });
});

describe('aggregateByService', () => {
  it('sums cost per service and sorts descending by total', () => {
    expect(aggregateByService(records)).toEqual([
      { service_name: 'Amazon EC2', total: 15 },
      { service_name: 'Amazon S3', total: 2 },
    ]);
  });
});

describe('totalCost', () => {
  it('sums the cost of every record', () => {
    expect(totalCost(records)).toBe(17);
  });

  it('returns 0 for no records', () => {
    expect(totalCost([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/reportAggregation.test.ts`
Expected: FAIL — `Cannot find module './reportAggregation'`.

- [ ] **Step 3: Write the aggregation module**

`lib/reportAggregation.ts`:
```ts
export interface AggregatableCostRecord {
  service_name: string;
  usage_date: string;
  cost: number;
}

export interface CostByDate {
  date: string;
  total: number;
}

export interface CostByService {
  service_name: string;
  total: number;
}

export function aggregateByDate(records: AggregatableCostRecord[]): CostByDate[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    totals.set(record.usage_date, (totals.get(record.usage_date) ?? 0) + record.cost);
  }
  return Array.from(totals.entries())
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function aggregateByService(records: AggregatableCostRecord[]): CostByService[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    totals.set(record.service_name, (totals.get(record.service_name) ?? 0) + record.cost);
  }
  return Array.from(totals.entries())
    .map(([service_name, total]) => ({ service_name, total }))
    .sort((a, b) => b.total - a.total);
}

export function totalCost(records: AggregatableCostRecord[]): number {
  return records.reduce((sum, record) => sum + record.cost, 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/reportAggregation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing tests for date-range utilities**

`lib/dateRange.test.ts`:
```ts
import { computeDateRange, shiftReferenceDate } from './dateRange';

describe('computeDateRange', () => {
  it('returns the same start and end for "day"', () => {
    const range = computeDateRange('day', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-15', end: '2026-07-15' });
  });

  it('returns Monday-Sunday for "week", for a mid-week reference date', () => {
    // 2026-07-15 is a Wednesday
    const range = computeDateRange('week', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('returns Monday-Sunday for "week", when the reference date is a Sunday', () => {
    // 2026-07-19 is a Sunday
    const range = computeDateRange('week', new Date(Date.UTC(2026, 6, 19)));
    expect(range).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('returns the first and last day of the month for "month"', () => {
    const range = computeDateRange('month', new Date(Date.UTC(2026, 6, 15)));
    expect(range).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });
});

describe('shiftReferenceDate', () => {
  it('shifts by one day', () => {
    const result = shiftReferenceDate('day', new Date(Date.UTC(2026, 6, 15)), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-16');
  });

  it('shifts by one week', () => {
    const result = shiftReferenceDate('week', new Date(Date.UTC(2026, 6, 15)), -1);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-08');
  });

  it('shifts by one month, rolling over into the next year', () => {
    const result = shiftReferenceDate('month', new Date(Date.UTC(2026, 11, 15)), 1);
    expect(result.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx jest lib/dateRange.test.ts`
Expected: FAIL — `Cannot find module './dateRange'`.

- [ ] **Step 7: Write the date-range module**

`lib/dateRange.ts`:
```ts
export type Granularity = 'day' | 'week' | 'month';

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeDateRange(granularity: Granularity, referenceDate: Date): { start: string; end: string } {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  if (granularity === 'day') {
    const start = new Date(Date.UTC(year, month, day));
    return { start: toISODate(start), end: toISODate(start) };
  }

  if (granularity === 'week') {
    const current = new Date(Date.UTC(year, month, day));
    const dayOfWeek = current.getUTCDay(); // 0 = Sunday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(Date.UTC(year, month, day + diffToMonday));
    const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
    return { start: toISODate(monday), end: toISODate(sunday) };
  }

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0));
  return { start: toISODate(firstOfMonth), end: toISODate(lastOfMonth) };
}

export function shiftReferenceDate(granularity: Granularity, referenceDate: Date, direction: 1 | -1): Date {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  if (granularity === 'day') {
    return new Date(Date.UTC(year, month, day + direction));
  }
  if (granularity === 'week') {
    return new Date(Date.UTC(year, month, day + direction * 7));
  }
  return new Date(Date.UTC(year, month + direction, day));
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest lib/dateRange.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Commit**

```bash
git add lib/reportAggregation.ts lib/reportAggregation.test.ts lib/dateRange.ts lib/dateRange.test.ts
git commit -m "Add report aggregation and date-range utilities"
```

---

## Task 7: Login form

**Files:**
- Create: `components/auth/LoginForm.tsx`
- Create: `components/auth/LoginForm.module.css`
- Create: `components/auth/LoginForm.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client` (Task 2).
- Produces: `LoginForm` (default export, no props) — consumed by the top-level page in Task 11.

- [ ] **Step 1: Write the failing test**

`components/auth/LoginForm.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginForm from './LoginForm';

const signInWithPassword = jest.fn();
const resetPasswordForEmail = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmail(...args),
    },
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
    resetPasswordForEmail.mockReset();
  });

  it('signs in with the entered email and password', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'client@example.com',
      password: 'correct-horse',
    });
  });

  it('shows an error when sign-in fails', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login credentials' } });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
  });

  it('sends a password reset email when "Forgot password?" is clicked', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'client@example.com');
    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      'client@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/reset-password') })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/reset email sent/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/auth/LoginForm.test.tsx`
Expected: FAIL — `Cannot find module './LoginForm'`.

- [ ] **Step 3: Write the component**

`components/auth/LoginForm.tsx`:
```tsx
'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import styles from './LoginForm.module.css';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResetSent(false);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setSubmitting(false);

    if (signInError) {
      setError('Invalid email or password.');
      return;
    }

    router.refresh();
  }

  async function handleResetPassword() {
    if (!email) {
      setError('Enter your email above first, then click "Forgot password?"');
      return;
    }

    setError(null);
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (resetError) {
      setError('Could not send the reset email. Please try again.');
      return;
    }

    setResetSent(true);
  }

  return (
    <div className={styles.wrapper}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <h1>Cloud Cost Review Portal</h1>

        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {resetSent && (
          <p role="status" className={styles.status}>
            Password reset email sent — check your inbox.
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className={styles.linkButton} onClick={handleResetPassword}>
          Forgot password?
        </button>
      </form>
    </div>
  );
}
```

`components/auth/LoginForm.module.css`:
```css
.wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1.5rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 24rem;
}

.form h1 {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
}

.form label {
  font-weight: 600;
}

.form input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
  background: var(--color-bg);
  color: var(--color-fg);
}

.error {
  color: #d1274b;
  font-size: 0.875rem;
}

.status {
  color: var(--color-fg);
  font-size: 0.875rem;
}

.submit {
  background: var(--color-accent);
  color: #fff;
  font-weight: 700;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.submit:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.linkButton {
  background: none;
  border: none;
  color: var(--color-accent);
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
  padding: 0;
  align-self: flex-start;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/auth/LoginForm.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add components/auth/LoginForm.tsx components/auth/LoginForm.module.css components/auth/LoginForm.test.tsx
git commit -m "Add login form"
```

---

## Task 8: Upload flow

**Files:**
- Create: `lib/admin-guard.ts`
- Create: `app/api/upload/route.ts`
- Create: `components/upload/UploadForm.tsx`
- Create: `components/upload/UploadForm.module.css`
- Create: `components/upload/UploadForm.test.tsx`

**Interfaces:**
- Consumes: `createClient` (server) from `@/lib/supabase/server`, `createAdminClient` from `@/lib/supabase/admin`, `parseCostFile` from `@/lib/parseCostFile` (Task 5).
- Produces: `requireCompanyAccess(companyId)` helper; `POST /api/upload` (multipart form: `file`, `cloudProvider`, `companyId`) → `{ uploadedFileId }` on success; `UploadForm` (props `{ companyId: string; onUploaded?: () => void }`) — `onUploaded` is consumed by `UploadedFilesList` (Task 9) to trigger a refresh after a successful upload. (Phase 3 adds a second guard, `requireStaff`, to this same file when the Admin tab needs it — do not add it now.)

- [ ] **Step 1: Write the access-guard helper**

`lib/admin-guard.ts`:
```ts
import { createClient } from '@/lib/supabase/server';

type AccessGuardResult =
  | { authorized: true; userId: string; role: 'client' | 'staff' }
  | { authorized: false; status: number; message: string };

export async function requireCompanyAccess(companyId: string): Promise<AccessGuardResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { authorized: false, status: 401, message: 'Not signed in.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, company_id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return { authorized: false, status: 403, message: 'No profile found.' };
  }

  if (profile.role === 'staff') {
    return { authorized: true, userId: user.id, role: 'staff' };
  }

  if (profile.company_id === companyId) {
    return { authorized: true, userId: user.id, role: 'client' };
  }

  return { authorized: false, status: 403, message: 'You do not have access to this company.' };
}
```

- [ ] **Step 2: Write the upload route**

`app/api/upload/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCostFile } from '@/lib/parseCostFile';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get('file');
  const cloudProvider = formData.get('cloudProvider');
  const companyId = formData.get('companyId');

  if (!(file instanceof File) || typeof cloudProvider !== 'string' || typeof companyId !== 'string') {
    return NextResponse.json({ error: 'Missing file, cloudProvider, or companyId.' }, { status: 400 });
  }
  if (cloudProvider !== 'aws' && cloudProvider !== 'azure') {
    return NextResponse.json({ error: 'cloudProvider must be "aws" or "azure".' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const storagePath = `${companyId}/${Date.now()}-${file.name}`;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await adminClient.storage
    .from('billing-files')
    .upload(storagePath, fileBuffer, { contentType: file.type || 'application/octet-stream' });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: uploadedFile, error: insertFileError } = await adminClient
    .from('uploaded_files')
    .insert({
      company_id: companyId,
      cloud_provider: cloudProvider,
      filename: file.name,
      storage_path: storagePath,
      status: 'processing',
      uploaded_by: guard.userId,
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the upload.' }, { status: 500 });
  }

  const { rows, errors } = parseCostFile(fileBuffer);

  if (rows.length === 0) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: errors.join(' ') || 'No valid rows found.' })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors });
  }

  const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
    rows.map((row) => ({
      company_id: companyId,
      cloud_provider: cloudProvider,
      service_name: row.service_name,
      usage_date: row.usage_date,
      cost: row.cost,
      account_id: row.account_id,
      source_file_id: uploadedFile.id,
    }))
  );

  if (insertRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: insertRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'error', errors: [insertRecordsError.message] });
  }

  await adminClient
    .from('uploaded_files')
    .update({ status: 'processed', row_count: rows.length })
    .eq('id', uploadedFile.id);

  return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'processed', rowCount: rows.length });
}
```

- [ ] **Step 3: Write the failing test for the UI**

`components/upload/UploadForm.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UploadForm from './UploadForm';

describe('UploadForm', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uploads a file and calls onUploaded on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ uploadedFileId: 'file-1', status: 'processed', rowCount: 3 }),
    });
    const onUploaded = jest.fn();
    const user = userEvent.setup();
    render(<UploadForm companyId="company-1" onUploaded={onUploaded} />);

    const file = new File(['a,b,c'], 'aws-export.xlsx', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText(/file/i), file);
    await user.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/upload', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/3 rows/i)).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalled();
  });

  it('shows the parser errors when the file fails to process', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ uploadedFileId: 'file-1', status: 'error', errors: ['Could not find a "Cost" column.'] }),
    });
    const user = userEvent.setup();
    render(<UploadForm companyId="company-1" />);

    const file = new File(['a,b,c'], 'bad-export.xlsx', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText(/file/i), file);
    await user.click(screen.getByRole('button', { name: /upload/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not find a "cost" column/i);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx jest components/upload/UploadForm.test.tsx`
Expected: FAIL — `Cannot find module './UploadForm'`.

- [ ] **Step 5: Write the component**

`components/upload/UploadForm.tsx`:
```tsx
'use client';

import { useState, FormEvent } from 'react';
import type { CloudProvider } from '@/lib/types';
import styles from './UploadForm.module.css';

interface UploadFormProps {
  companyId: string;
  onUploaded?: () => void;
}

type Status = 'idle' | 'uploading' | 'error';

export default function UploadForm({ companyId, onUploaded }: UploadFormProps) {
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('aws');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;

    setStatus('uploading');
    setErrors([]);
    setSuccessMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('cloudProvider', cloudProvider);
    formData.append('companyId', companyId);

    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    const body = await response.json();

    if (!response.ok) {
      setStatus('error');
      setErrors([body.error ?? 'Upload failed.']);
      return;
    }

    if (body.status === 'error') {
      setStatus('error');
      setErrors(body.errors ?? ['Could not process the file.']);
      return;
    }

    setStatus('idle');
    setFile(null);
    setSuccessMessage(`Uploaded — ${body.rowCount} rows processed.`);
    onUploaded?.();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h3>Upload a billing file</h3>

      <label htmlFor="cloud-provider">Cloud provider</label>
      <select
        id="cloud-provider"
        value={cloudProvider}
        onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
      >
        <option value="aws">AWS</option>
        <option value="azure">Azure</option>
      </select>

      <label htmlFor="upload-file">File</label>
      <input
        id="upload-file"
        type="file"
        accept=".xlsx,.csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        required
      />

      {errors.length > 0 && (
        <div role="alert" className={styles.error}>
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      {successMessage && (
        <p role="status" className={styles.status}>
          {successMessage}
        </p>
      )}

      <button type="submit" disabled={status === 'uploading'}>
        {status === 'uploading' ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}
```

Note: the `cloudProvider` selector already includes "Azure" even though Phase 1 doesn't yet display an Azure report tab — an upload made against a company will still parse and store correctly regardless of provider, so there's no reason to hide the option. Phase 2 simply adds the tab that reads it back.

`components/upload/UploadForm.module.css`:
```css
.form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 24rem;
}

.form label {
  font-weight: 600;
}

.form select,
.form input[type='file'] {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.form button[type='submit'] {
  background: var(--color-accent);
  color: #fff;
  border: none;
  padding: 0.6rem 1.25rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
  align-self: flex-start;
}

.error {
  color: #d1274b;
}

.status {
  color: var(--color-fg);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest components/upload/UploadForm.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Verify the route handler type-checks and the full pipeline builds**

Run: `npx tsc --noEmit` — expect no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/admin-guard.ts app/api/upload components/upload
git commit -m "Add billing file upload flow"
```

---

## Task 9: Uploaded Files tab

**Files:**
- Create: `components/files/UploadedFilesList.tsx`
- Create: `components/files/UploadedFilesList.module.css`
- Create: `components/files/UploadedFilesList.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client` (Task 2), `UploadedFile` type from `@/lib/types` (Task 2), `UploadForm` from `@/components/upload/UploadForm` (Task 8).
- Produces: `UploadedFilesList` (default export, props `{ companyId: string }`) — consumed by the app shell in Task 11.

- [ ] **Step 1: Write the failing test**

`components/files/UploadedFilesList.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import UploadedFilesList from './UploadedFilesList';

const listFiles = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: (...args: unknown[]) => listFiles(...args),
        }),
      }),
    }),
  }),
}));

describe('UploadedFilesList', () => {
  beforeEach(() => {
    listFiles.mockReset();
  });

  it('lists uploaded files with their status', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-1',
          company_id: 'company-1',
          cloud_provider: 'aws',
          filename: 'july-aws.xlsx',
          storage_path: 'company-1/july-aws.xlsx',
          status: 'processed',
          error_message: null,
          row_count: 42,
          uploaded_by: 'user-1',
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText('july-aws.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Processed')).toBeInTheDocument();
    expect(screen.getByText('42 rows')).toBeInTheDocument();
  });

  it('shows the error message for a failed upload', async () => {
    listFiles.mockResolvedValueOnce({
      data: [
        {
          id: 'file-2',
          company_id: 'company-1',
          cloud_provider: 'azure',
          filename: 'bad.xlsx',
          storage_path: 'company-1/bad.xlsx',
          status: 'error',
          error_message: 'Could not find a "Cost" column.',
          row_count: null,
          uploaded_by: 'user-1',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
    });

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText('bad.xlsx')).toBeInTheDocument();
    expect(screen.getByText(/could not find a "cost" column/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no files', async () => {
    listFiles.mockResolvedValueOnce({ data: [] });

    render(<UploadedFilesList companyId="company-1" />);

    expect(await screen.findByText(/no files uploaded yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/files/UploadedFilesList.test.tsx`
Expected: FAIL — `Cannot find module './UploadedFilesList'`.

- [ ] **Step 3: Write the component**

`components/files/UploadedFilesList.tsx`:
```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { UploadedFile } from '@/lib/types';
import UploadForm from '@/components/upload/UploadForm';
import styles from './UploadedFilesList.module.css';

interface UploadedFilesListProps {
  companyId: string;
}

const STATUS_LABELS: Record<UploadedFile['status'], string> = {
  processing: 'Processing',
  processed: 'Processed',
  error: 'Error',
};

export default function UploadedFilesList({ companyId }: UploadedFilesListProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);

  const loadFiles = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('uploaded_files')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    setFiles(data ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  return (
    <div className={styles.wrapper}>
      <UploadForm companyId={companyId} onUploaded={loadFiles} />

      {loading ? (
        <p>Loading files…</p>
      ) : files.length === 0 ? (
        <p>No files uploaded yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>File</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.id}>
                <td>{file.filename}</td>
                <td>{file.cloud_provider === 'aws' ? 'AWS' : 'Azure'}</td>
                <td>
                  {STATUS_LABELS[file.status]}
                  {file.status === 'processed' && file.row_count !== null && ` — ${file.row_count} rows`}
                  {file.status === 'error' && file.error_message && (
                    <span className={styles.errorMessage}> — {file.error_message}</span>
                  )}
                </td>
                <td>{new Date(file.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

`components/files/UploadedFilesList.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.errorMessage {
  color: #d1274b;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/files/UploadedFilesList.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add components/files
git commit -m "Add Uploaded Files tab"
```

---

## Task 10: AWS cost report tab

**Files:**
- Create: `components/reports/DateRangePicker.tsx`
- Create: `components/reports/DateRangePicker.module.css`
- Create: `components/reports/DateRangePicker.test.tsx`
- Create: `components/reports/CostReportTab.tsx`
- Create: `components/reports/CostReportTab.module.css`
- Create: `components/reports/CostReportTab.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client` (Task 2), `CostRecord`/`CloudProvider` types from `@/lib/types` (Task 2), `aggregateByDate`/`aggregateByService`/`totalCost` from `@/lib/reportAggregation`, `computeDateRange`/`shiftReferenceDate`/`Granularity` from `@/lib/dateRange` (both Task 6).
- Produces: `DateRangePicker` (props `{ granularity: Granularity; onGranularityChange: (g: Granularity) => void; rangeLabel: string; onPrev: () => void; onNext: () => void }`); `CostReportTab` (default export, props `{ companyId: string; cloudProvider: CloudProvider }`) — consumed by the app shell in Task 11 with `cloudProvider="aws"`. **Build this component generically, parameterized by `cloudProvider`, even though only the AWS instance is wired up in this phase** — Phase 2 reuses this exact component unchanged for Azure, and Phase 2's Compare tab reuses its `DateRangePicker` too.

- [ ] **Step 1: Write the failing test for `DateRangePicker`**

`components/reports/DateRangePicker.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateRangePicker from './DateRangePicker';

describe('DateRangePicker', () => {
  it('calls onGranularityChange when a granularity button is clicked', async () => {
    const onGranularityChange = jest.fn();
    const user = userEvent.setup();
    render(
      <DateRangePicker
        granularity="month"
        onGranularityChange={onGranularityChange}
        rangeLabel="2026-07-01 – 2026-07-31"
        onPrev={jest.fn()}
        onNext={jest.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Week' }));

    expect(onGranularityChange).toHaveBeenCalledWith('week');
  });

  it('calls onPrev and onNext, and displays the range label', async () => {
    const onPrev = jest.fn();
    const onNext = jest.fn();
    const user = userEvent.setup();
    render(
      <DateRangePicker
        granularity="month"
        onGranularityChange={jest.fn()}
        rangeLabel="2026-07-01 – 2026-07-31"
        onPrev={onPrev}
        onNext={onNext}
      />
    );

    expect(screen.getByText('2026-07-01 – 2026-07-31')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /previous/i }));
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(onPrev).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/reports/DateRangePicker.test.tsx`
Expected: FAIL — `Cannot find module './DateRangePicker'`.

- [ ] **Step 3: Write `DateRangePicker`**

`components/reports/DateRangePicker.tsx`:
```tsx
import type { Granularity } from '@/lib/dateRange';
import styles from './DateRangePicker.module.css';

interface DateRangePickerProps {
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
  rangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export default function DateRangePicker({
  granularity,
  onGranularityChange,
  rangeLabel,
  onPrev,
  onNext,
}: DateRangePickerProps) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.granularityGroup}>
        {GRANULARITIES.map((g) => (
          <button
            key={g.value}
            type="button"
            aria-pressed={granularity === g.value}
            onClick={() => onGranularityChange(g.value)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className={styles.navGroup}>
        <button type="button" aria-label="Previous" onClick={onPrev}>
          ←
        </button>
        <span>{rangeLabel}</span>
        <button type="button" aria-label="Next" onClick={onNext}>
          →
        </button>
      </div>
    </div>
  );
}
```

`components/reports/DateRangePicker.module.css`:
```css
.wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.granularityGroup {
  display: flex;
  gap: 0.5rem;
}

.granularityGroup button {
  background: none;
  border: 1px solid var(--color-border);
  padding: 0.4rem 1rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.granularityGroup button[aria-pressed='true'] {
  background: var(--color-accent);
  color: #fff;
  border-color: var(--color-accent);
}

.navGroup {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.navGroup button {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  width: 2rem;
  height: 2rem;
  cursor: pointer;
  font: inherit;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/reports/DateRangePicker.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `CostReportTab`**

`components/reports/CostReportTab.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import CostReportTab from './CostReportTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () => ({
              lte: (...args: unknown[]) => loadRecords(...args),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// Recharts renders to SVG with layout measurements jsdom doesn't provide;
// stub it to a lightweight marker so tests assert on our data, not on chart rendering.
jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy(
    {},
    {
      get: () => Passthrough,
    }
  );
});

describe('CostReportTab', () => {
  beforeEach(() => {
    loadRecords.mockReset();
  });

  it('shows the total cost and a per-service breakdown for the current month', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
      ],
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('Amazon S3')).toBeInTheDocument();
  });

  it('shows an empty state when there are no records in range', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" />);

    expect(await screen.findByText(/no cost data for this range/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: FAIL — `Cannot find module './CostReportTab'`.

- [ ] **Step 7: Write `CostReportTab`**

`components/reports/CostReportTab.tsx`:
```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { aggregateByDate, aggregateByService, totalCost } from '@/lib/reportAggregation';
import { computeDateRange, shiftReferenceDate, type Granularity } from '@/lib/dateRange';
import DateRangePicker from './DateRangePicker';
import styles from './CostReportTab.module.css';

interface CostReportTabProps {
  companyId: string;
  cloudProvider: CloudProvider;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CostReportTab({ companyId, cloudProvider }: CostReportTabProps) {
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [referenceDate, setReferenceDate] = useState(() => new Date());
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => computeDateRange(granularity, referenceDate), [granularity, referenceDate]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('cost_records')
        .select('*')
        .eq('company_id', companyId)
        .eq('cloud_provider', cloudProvider)
        .gte('usage_date', range.start)
        .lte('usage_date', range.end);

      if (!cancelled) {
        setRecords(data ?? []);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, cloudProvider, range.start, range.end]);

  const byDate = useMemo(() => aggregateByDate(records), [records]);
  const byService = useMemo(() => aggregateByService(records), [records]);
  const total = useMemo(() => totalCost(records), [records]);

  return (
    <div className={styles.wrapper}>
      <DateRangePicker
        granularity={granularity}
        onGranularityChange={setGranularity}
        rangeLabel={`${range.start} – ${range.end}`}
        onPrev={() => setReferenceDate((prev) => shiftReferenceDate(granularity, prev, -1))}
        onNext={() => setReferenceDate((prev) => shiftReferenceDate(granularity, prev, 1))}
      />

      {loading ? (
        <p>Loading…</p>
      ) : records.length === 0 ? (
        <p>No cost data for this range.</p>
      ) : (
        <>
          <p className={styles.total}>{formatCurrency(total)}</p>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={byDate}>
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="total" stroke="#2258d3" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={byService}>
                <XAxis dataKey="service_name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="total" fill="#2258d3" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {byService.map((row) => (
                <tr key={row.service_name}>
                  <td>{row.service_name}</td>
                  <td>{formatCurrency(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

`components/reports/CostReportTab.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.total {
  font-size: 2rem;
  font-weight: 800;
}

.chart {
  background: var(--color-bg-alt);
  border-radius: 8px;
  padding: 1rem;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add components/reports/DateRangePicker.tsx components/reports/DateRangePicker.module.css components/reports/DateRangePicker.test.tsx components/reports/CostReportTab.tsx components/reports/CostReportTab.module.css components/reports/CostReportTab.test.tsx
git commit -m "Add AWS cost report tab with date-range picker and charts"
```

---

## Task 11: App shell — login/dashboard dispatcher, AWS + Uploaded Files tabs, proxy

**Files:**
- Modify: `app/page.tsx` (full replacement of Task 1's placeholder)
- Create: `components/shell/AppShell.tsx`
- Create: `components/shell/AppShell.module.css`
- Create: `components/shell/AppShell.test.tsx`
- Create: `proxy.ts`

**Interfaces:**
- Consumes: `createClient` (server) from `@/lib/supabase/server`, `createClient` (browser) from `@/lib/supabase/client` (Task 2), `LoginForm` (Task 7), `UploadedFilesList` (Task 9), `CostReportTab` (Task 10), `Company`/`ProfileRole` types (Task 2).
- Produces: the live `/` route, and `AppShell` (default export, props `{ userId: string; role: ProfileRole; companyId: string | null }`). **Phase 2 and Phase 3 both modify `AppShell.tsx` again** to add more tabs (Azure, Compare, then Notes & Follow-ups, Admin) — build the tab list and panel-switch logic in a way that's easy to extend, not a one-off.

- [ ] **Step 1: Write the failing test for `AppShell`**

`components/shell/AppShell.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppShell from './AppShell';

jest.mock('./../files/UploadedFilesList', () => ({
  __esModule: true,
  default: () => <div>files-tab-content</div>,
}));
jest.mock('./../reports/CostReportTab', () => ({
  __esModule: true,
  default: ({ cloudProvider }: { cloudProvider: string }) => <div>report-tab-content for {cloudProvider}</div>,
}));

const signOut = jest.fn();
const listCompanies = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signOut: (...args: unknown[]) => signOut(...args) },
    from: () => ({ select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }) }),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('AppShell', () => {
  beforeEach(() => {
    signOut.mockReset();
    listCompanies.mockReset();
  });

  it('shows the AWS tab and the Uploaded Files tab for a client', async () => {
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    expect(screen.getByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /uploaded files/i })).toBeInTheDocument();
  });

  it('switches to the Uploaded Files tab when clicked', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('tab', { name: /uploaded files/i }));

    expect(screen.getByText('files-tab-content')).toBeInTheDocument();
  });

  it('shows a company switcher for staff', async () => {
    listCompanies.mockResolvedValueOnce({
      data: [
        { id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' },
        { id: 'c2', name: 'Globex', created_at: '2026-07-02T00:00:00.000Z' },
      ],
    });

    render(<AppShell userId="staff-1" role="staff" companyId={null} />);

    expect(await screen.findByLabelText(/viewing company/i)).toBeInTheDocument();
  });

  it('signs the user out when Sign out is clicked', async () => {
    signOut.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(signOut).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: FAIL — `Cannot find module './AppShell'`.

- [ ] **Step 3: Write `AppShell`**

`components/shell/AppShell.tsx`:
```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import styles from './AppShell.module.css';

type TabKey = 'aws' | 'files';

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
}

export default function AppShell({ role, companyId }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(companyId);
  const router = useRouter();

  useEffect(() => {
    if (role !== 'staff') return;

    async function loadCompanies() {
      const supabase = createClient();
      const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
      setCompanies(data ?? []);
      if (data && data.length > 0 && !selectedCompanyId) {
        setSelectedCompanyId(data[0].id);
      }
    }

    loadCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
  }

  const effectiveCompanyId = role === 'staff' ? selectedCompanyId : companyId;

  return (
    <div className={styles.wrapper}>
      <div className={styles.topBar}>
        <h1>Cloud Cost Review Portal</h1>
        {role === 'staff' && (
          <div className={styles.companySwitcher}>
            <label htmlFor="company-switcher">Viewing company</label>
            <select
              id="company-switcher"
              value={selectedCompanyId ?? ''}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="button" className={styles.signOut} onClick={handleSignOut}>
          Sign out
        </button>
      </div>

      <div className={styles.tabList} role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'aws'} onClick={() => setActiveTab('aws')}>
          AWS
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'files'} onClick={() => setActiveTab('files')}>
          Uploaded Files
        </button>
      </div>

      <div className={styles.panel}>
        {!effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : (
          <>
            {activeTab === 'aws' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="aws" />}
            {activeTab === 'files' && <UploadedFilesList companyId={effectiveCompanyId} />}
          </>
        )}
      </div>
    </div>
  );
}
```

`components/shell/AppShell.module.css`:
```css
.wrapper {
  max-width: 72rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}

.topBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.companySwitcher {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.companySwitcher select {
  padding: 0.4rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.signOut {
  background: none;
  border: 1px solid var(--color-border);
  padding: 0.5rem 1rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
  color: var(--color-fg);
}

.tabList {
  display: flex;
  gap: 0.5rem;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.tabList button {
  background: none;
  border: none;
  padding: 0.75rem 1.25rem;
  font: inherit;
  font-weight: 600;
  color: var(--color-muted);
  cursor: pointer;
  border-bottom: 3px solid transparent;
}

.tabList button[aria-selected='true'] {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the top-level page**

`app/page.tsx` (full replacement of Task 1's placeholder):
```tsx
import { createClient } from '@/lib/supabase/server';
import LoginForm from '@/components/auth/LoginForm';
import AppShell from '@/components/shell/AppShell';

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <LoginForm />;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, company_id')
    .eq('id', user.id)
    .single();

  return (
    <AppShell
      userId={user.id}
      role={profile?.role === 'staff' ? 'staff' : 'client'}
      companyId={profile?.company_id ?? null}
    />
  );
}
```

No dedicated unit test for this Server Component — same reasoning as the training portal (mocking `next/headers` deeply enough isn't worth it for a few lines; covered by Task 12's manual pass).

- [ ] **Step 6: Write the session-refresh proxy**

This Next.js version requires the file to be named `proxy.ts` at the project root, exporting a function named `proxy` — do not name it `middleware.ts`. Verify this against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` in this project if in doubt.

`proxy.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function proxy(request: NextRequest) {
  const passthrough = NextResponse.next({ request });

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

  if (!url || !anonKey) {
    console.error(
      `proxy: missing Supabase env vars (url present: ${Boolean(url)}, anonKey present: ${Boolean(anonKey)}) — skipping session refresh`
    );
    return passthrough;
  }

  try {
    let response = passthrough;

    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    await supabase.auth.getUser();
    return response;
  } catch (error) {
    console.error('proxy: session refresh failed, passing request through', error);
    return passthrough;
  }
}

export const config = {
  matcher: ['/:path*'],
};
```

Every route in this app requires a session (there's no separate public marketing site here, unlike the training portal), so scoping the matcher to everything is correct. The try/catch resilience pattern — never let a failed session refresh crash the route — is carried over directly from a lesson learned deploying the training portal.

- [ ] **Step 7: Verify the build**

Run: `npx tsc --noEmit` — expect no errors.
Run: `npm run build` — expect a successful build, with `/` listed as a route and `Proxy (Middleware)` recognized.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx components/shell proxy.ts
git commit -m "Wire up the app shell: login/dashboard dispatcher, AWS + Uploaded Files tabs, session-refresh proxy"
```

---

## Task 12: Manual verification and deployment

**Files:** none (verification and deployment only).

- [ ] **Step 1: Run the full test suite, lint, and build**

Run: `npm test` — expect all tests passing.
Run: `npm run lint` — expect no errors.
Run: `npm run build` — expect a successful production build.

- [ ] **Step 2: Bootstrap the first staff account, company, and client account (manual, one-time)**

There's no Admin UI yet in this phase, so the very first company and users are created by hand:

1. In the Supabase dashboard → Authentication → Users → Add user, create the staff account (Auto Confirm checked) using the site owner's real email.
2. Promote it via `mcp__supabase__execute_sql`:
   ```sql
   update public.profiles set role = 'staff' where email = '<staff email>';
   ```
3. Create a test company:
   ```sql
   insert into public.companies (name) values ('Test Company') returning id;
   ```
4. In the Supabase dashboard, create a second account for a test client user (Auto Confirm checked), then link it to that company:
   ```sql
   update public.profiles set company_id = '<company id from step 3>', role = 'client' where email = '<client email>';
   ```

- [ ] **Step 3: Manual end-to-end pass on the local dev server**

Run `npm run dev`, sign in as the staff account:

1. Confirm the company switcher shows "Test Company" and selects it.
2. Upload a real (or realistic synthetic) AWS billing export — confirm it shows `processed` with a row count in Uploaded Files, and that the AWS tab now shows a total, a chart, and a per-service table.
3. Try day/week/month granularity and the prev/next navigation on the date range picker — confirm the chart/table update correctly for each.
4. Upload a deliberately malformed file (e.g., missing a Cost column) — confirm Uploaded Files shows `error` with a readable message, and no records were partially inserted.
5. Sign out, sign in as the test client account (private/incognito window) — confirm there's no company switcher (client is locked to their own company), and that they see the same AWS report and Uploaded Files data as staff saw for that company.
6. Create a second company + client via SQL the same way, confirm that client cannot see the first company's data (multi-tenancy check).

If anything fails, fix it and re-run the affected steps before deploying.

- [ ] **Step 4: Set up Vercel**

Create a new Vercel project linked to this repository (ask the controller/site owner to do this, or use `mcp__vercel__create_git_project` once the repo is pushed to GitHub). Add the three environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) to the Production environment in the Vercel dashboard — this is a manual step, confirm with the site owner before entering the service-role secret.

- [ ] **Step 5: Push to GitHub and deploy**

Confirm with the site owner before creating the GitHub repository and pushing — this is a new, separate repo from the training portal and the marketing site. Once pushed and Vercel is connected, verify the production deployment with the same end-to-end pass as Step 3.
