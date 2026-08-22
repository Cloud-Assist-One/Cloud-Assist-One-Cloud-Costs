# Stage B — Review Periods, Archive, Trend Sidebar & Reporting Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Day/Week/Month report model with a first-class "billing period" concept (one active review cycle per company, archived on demand), and build the enhanced reporting (Line Items tab, 12-month trend sidebar, chart polish, browser print) on top of it.

**Architecture:** A new `billing_periods` table (exactly one `active` row per company, enforced by a partial unique index) gains a `period_id` foreign key on `cost_records`/`uploaded_files`/`review_notes`/`review_todos`/`time_entries`, stamped automatically by a uniform `before insert` trigger (so the schema change is safe regardless of app-code deploy timing). Archiving is one atomic Postgres function (`archive_billing_period`) called from a new API route. `AppShell` gains a `viewingPeriodId` concept threading through every report tab, a new Archive tab, and a persistent trend sidebar.

**Tech Stack:** Next.js 16.3.1 (App Router), React 19.2.8, TypeScript, Supabase (Postgres/Auth/Storage), `@tanstack/react-table` (new dependency), Recharts, existing shadcn-style hand-authored primitives from Stage A, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-22-stage-b-review-periods-and-reporting-design.md`

## Global Constraints

- Follow existing project conventions: `@/*` path alias, tests co-located as `Component.test.tsx`, functional components with hooks, 2-space indentation, CSS Modules for component styling (shadcn/Tailwind utilities only inside `components/ui/*` primitives, per Stage A's established boundary).
- Every new table/view/function gets RLS via `private.is_staff()`/`private.user_company_id()` (wrapped in `(select ...)` for per-statement caching) **plus explicit base-table GRANTs in the same migration** — a prior gap here silently broke earlier phases; this is non-negotiable.
- The "exactly one active period per company" invariant is enforced by a database-level partial unique index, not application logic alone.
- All writes to period-scoped tables determine `period_id` **server-side** (via the uniform trigger) — no application code ever sets or trusts a client-supplied `period_id`.
- PostgREST's ~1000-row page cap means the Line Items table uses true server-side pagination (`.range()` per page, a separate `count`-only query) — never the "page through everything client-side" pattern used elsewhere in this codebase for aggregation.
- The 12-month trend sidebar reads from a dedicated server-side aggregate view, never raw `cost_records` paged client-side.
- The shadcn CLI remains environmentally broken in this repo (npm 11 rejects a flag it unconditionally passes — documented in Stage A's SDD ledger). Any new shadcn-style primitive (this stage: `components/ui/table.tsx`) is hand-authored from the real upstream template, exactly like Stage A's Button/Tabs/Card/Badge.
- Zero regressions in the existing test suite (`npm test`) — every existing test must still pass after each task. Tests that need updating because a component's props/query shape genuinely changed (not because of a bug) are expected, explicitly-called-out changes, not silent workarounds.
- No API route in this codebase has automated tests (confirmed: `app/api/upload/route.ts` and `app/api/admin/users/*` are both untested) — new API routes in this plan follow that same convention and are verified manually, not with Jest.
- The Supabase project is shared/live, not per-worktree — a migration applied via the Supabase MCP tools during development lands on the real project immediately. Nothing in this plan's migration should break the live app's current behavior at any point during development (this is why the trigger-based `period_id` stamping is required — see Task 1).

---

## Task 1: Migration — billing_periods, period-stamping trigger, backfill, trend view, archive function

**Files:**
- Create: `supabase/migrations/20260822000000_billing_periods.sql`

**Interfaces:**
- Consumes: existing `public.companies`, `public.cost_records`, `public.uploaded_files`, `public.review_notes`, `public.review_todos`, `public.time_entries` tables; existing `private.is_staff()`/`private.user_company_id()` helpers.
- Produces: `public.billing_periods` table (`id`, `company_id`, `status` `'active'|'archived'`, `created_at`, `archived_at`); `period_id uuid not null` column on all 5 existing tables; `public.archive_billing_period(p_company_id uuid) returns uuid` (callable via `service_role` only); `public.monthly_cost_by_provider` view (`company_id`, `month`, `cloud_provider`, `total`). Later tasks consume all of these exact names.

This task has no automated test (it's a schema migration, matching this project's established convention that schema changes are verified via direct SQL checks, not Jest) — verification is a sequence of `execute_sql` calls proving each piece behaves correctly.

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP `apply_migration` tool with name `billing_periods` and the SQL above (or run it directly against the project if MCP tools aren't available in this environment — check which is the case before proceeding).

- [ ] **Step 3: Verify the partial unique index blocks a second active period**

Run via `execute_sql`:
```sql
select company_id, count(*) from public.billing_periods where status = 'active' group by company_id having count(*) > 1;
```
Expected: zero rows (every company has at most one active period).

- [ ] **Step 4: Verify backfill correctness**

Run via `execute_sql`:
```sql
select count(*) from public.cost_records where period_id is null;
select count(*) from public.uploaded_files where period_id is null;
select count(*) from public.review_notes where period_id is null;
select count(*) from public.review_todos where period_id is null;
select count(*) from public.time_entries where period_id is null;
```
Expected: `0` for every query (the `not null` constraint already guarantees this structurally, but confirm no migration step silently failed).

- [ ] **Step 5: Verify the trigger stamps new inserts correctly**

Run via `execute_sql` (pick any existing `company_id` from `public.companies`, substitute below):
```sql
insert into public.cost_records (company_id, cloud_provider, service_name, usage_date, cost, source_file_id)
values ('<existing-company-id>', 'aws', 'Test Service', current_date, 1.23,
  (select id from public.uploaded_files where company_id = '<existing-company-id>' limit 1))
returning period_id;
```
Expected: returns the company's current active period's id (not null, not client-supplied). Then delete this test row: `delete from public.cost_records where service_name = 'Test Service' and cost = 1.23;`.

- [ ] **Step 6: Verify the archive function is atomic and correct**

Run via `execute_sql` (pick a company with no important data, or accept the test churn — this is dev data):
```sql
select public.archive_billing_period('<existing-company-id>');
```
Expected: returns a new uuid. Then confirm exactly one active and at least one archived period exist for that company:
```sql
select status, count(*) from public.billing_periods where company_id = '<existing-company-id>' group by status;
```
Expected: one row with `status = 'active', count = 1`, and at least one row with `status = 'archived'`.

- [ ] **Step 7: Verify the trend view respects RLS and returns sane aggregates**

Run via `execute_sql` (as a superuser this bypasses RLS by design of the tool — the important check here is just that the view's aggregation is arithmetically correct, not the RLS enforcement, which is structurally guaranteed by `security_invoker` plus the base table's existing, already-tested policies):
```sql
select * from public.monthly_cost_by_provider where company_id = '<existing-company-id>' order by month;
```
Expected: one row per (month, cloud_provider) combination present in that company's `cost_records`, `total` matching a manual `sum(cost)` for a spot-checked month.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260822000000_billing_periods.sql
git commit -m "Add billing_periods table, period-stamping trigger, archive function, trend view"
```

---

## Task 2: Update types and scope the upload route's re-upload dedup to period_id

**Files:**
- Modify: `lib/types.ts`, `app/api/upload/route.ts`

**Interfaces:**
- Consumes: `period_id` column on `cost_records`/`uploaded_files` (Task 1), `public.billing_periods` table (Task 1).
- Produces: `BillingPeriod` type; `period_id: string` field on `CostRecord`, `UploadedFile`, `ReviewNote`, `ReviewTodo`, `TimeEntry` — every later task that touches these types relies on this field existing.

- [ ] **Step 1: Add the `BillingPeriod` type and `period_id` fields**

In `lib/types.ts`, add after the `Company` interface:

```typescript
export type BillingPeriodStatus = 'active' | 'archived';

export interface BillingPeriod {
  id: string;
  company_id: string;
  status: BillingPeriodStatus;
  created_at: string;
  archived_at: string | null;
}
```

Then add `period_id: string;` to `CostRecord`, `UploadedFile`, `ReviewNote`, `ReviewTodo`, and `TimeEntry` (each already has `company_id: string;` — add the new field on the line directly after it in each interface).

- [ ] **Step 2: Scope the re-upload dedup delete to the active period**

In `app/api/upload/route.ts`, the existing code reads (around line 24):

```typescript
  const adminClient = createAdminClient();
  const storagePath = `${companyId}/${Date.now()}-${file.name}`;
```

Add the active-period lookup right after `const adminClient = createAdminClient();`, reusing that same client instance (no need for a second one):

```typescript
  const adminClient = createAdminClient();

  const { data: activePeriod, error: activePeriodError } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .single();

  if (activePeriodError || !activePeriod) {
    return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
  }

  const storagePath = `${companyId}/${Date.now()}-${file.name}`;
```

Then find the existing delete-dedup block:

```typescript
    const { error: deleteRecordsError } = await adminClient
      .from('cost_records')
      .delete()
      .eq('company_id', companyId)
      .eq('cloud_provider', cloudProvider)
      .gte('usage_date', rangeStart)
      .lte('usage_date', rangeEnd);
```

and add a `period_id` scope so a re-upload can never delete rows belonging to an already-archived period:

```typescript
    const { error: deleteRecordsError } = await adminClient
      .from('cost_records')
      .delete()
      .eq('company_id', companyId)
      .eq('cloud_provider', cloudProvider)
      .eq('period_id', activePeriod.id)
      .gte('usage_date', rangeStart)
      .lte('usage_date', rangeEnd);
```

No other change is needed to this route — `cost_records`/`uploaded_files` inserts don't need to set `period_id` themselves; Task 1's trigger stamps it automatically on every insert.

- [ ] **Step 3: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass (this task changes no test-covered behavior directly, but confirm nothing broke).

- [ ] **Step 4: Commit**

```bash
git add lib/types.ts app/api/upload/route.ts
git commit -m "Add BillingPeriod type, period_id fields, scope re-upload dedup to active period"
```

---

## Task 3: Archive API route

**Files:**
- Create: `app/api/periods/archive/route.ts`

**Interfaces:**
- Consumes: `public.archive_billing_period` (Task 1), `requireCompanyAccess` from `lib/admin-guard.ts` (existing), `createAdminClient` from `lib/supabase/admin.ts` (existing).
- Produces: `POST /api/periods/archive` — body `{ companyId: string }`, success response `{ newPeriodId: string }`, following the same route shape conventions as `app/api/upload/route.ts`. Task 10 (AppShell's "Archive this period" button) calls this exact endpoint/shape.

No automated test for this route, per the Global Constraints (matches the existing convention for `app/api/upload/route.ts` and `app/api/admin/users/*`).

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const companyId = body?.companyId;

  if (typeof companyId !== 'string' || companyId.length === 0) {
    return NextResponse.json({ error: 'Missing companyId.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('archive_billing_period', { p_company_id: companyId });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ newPeriodId: data });
}
```

- [ ] **Step 2: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 3: Manually verify via a direct request**

With the dev server running and signed in (or via a direct `curl`/`fetch` with a valid session cookie — describe whichever is easiest in your environment), `POST /api/periods/archive` with `{ "companyId": "<a real company id>" }` for a company you're authorized for. Confirm the response is `{ "newPeriodId": "<uuid>" }` and that `billing_periods` now shows that company with one `archived` row (the one that was previously active) and one new `active` row with a different id. Also verify a non-existent/unauthorized `companyId` returns the guard's 401/403 as expected.

- [ ] **Step 4: Commit**

```bash
git add app/api/periods/archive/route.ts
git commit -m "Add /api/periods/archive route"
```

---

## Task 4: Period-scope NotesFeed and UploadedFilesList, add read-only mode

**Files:**
- Modify: `components/notes/NotesFeed.tsx`, `components/notes/NotesFeed.test.tsx`, `components/files/UploadedFilesList.tsx`, `components/files/UploadedFilesList.test.tsx`

**Interfaces:**
- Consumes: `period_id` field (Task 2) on `ReviewNote`/`ReviewTodo`/`TimeEntry`/`UploadedFile`.
- Produces: `NotesFeed` gains `periodId: string` and `isReadOnly: boolean` props; `UploadedFilesList` gains `periodId: string` and `isReadOnly: boolean` props. Task 10 (AppShell) passes both to every rendering of these components.

- [ ] **Step 1: Update `NotesFeed`'s props and queries**

In `components/notes/NotesFeed.tsx`, change the props interface:

```typescript
interface NotesFeedProps {
  companyId: string;
  userId: string;
  isStaff: boolean;
  periodId: string;
  isReadOnly: boolean;
}
```

Update the function signature: `export default function NotesFeed({ companyId, userId, isStaff, periodId, isReadOnly }: NotesFeedProps) {`.

In `fetchAll`, add `.eq('period_id', periodId)` to all three queries and add `periodId` to the `useCallback` dependency array:

```typescript
  const fetchAll = useCallback(async () => {
    const supabase = createClient();
    const [notesResult, todosResult, timeEntriesResult] = await Promise.all([
      supabase
        .from('review_notes')
        .select('*')
        .eq('company_id', companyId)
        .eq('period_id', periodId)
        .order('created_at', { ascending: false }),
      supabase
        .from('review_todos')
        .select('*')
        .eq('company_id', companyId)
        .eq('period_id', periodId)
        .order('created_at', { ascending: false }),
      supabase
        .from('time_entries')
        .select('*')
        .eq('company_id', companyId)
        .eq('period_id', periodId)
        .order('entry_date', { ascending: false }),
    ]);
    return {
      notes: notesResult.data ?? [],
      todos: todosResult.data ?? [],
      timeEntries: timeEntriesResult.data ?? [],
    };
  }, [companyId, periodId]);
```

Change every `{isStaff && ( ... )}` write-form guard (time entry form, todo form, note form) to `{isStaff && !isReadOnly && ( ... )}` (there are three such guards — time entry form around line 252, todo form around line 298, note form around line 331). Also change the todo checkbox's `disabled={!isStaff}` to `disabled={!isStaff || isReadOnly}`.

- [ ] **Step 2: Update `NotesFeed.test.tsx`**

The current file mocks each of the three tables separately, each with a single `.eq()` link (`select: () => ({ eq: () => ({ order: (...args) => selectX(...args) }) })`). Add a second chained `.eq()` to all three, and add `periodId="period-1"` + `isReadOnly={false}` to every existing `render(<NotesFeed .../>)` call (there are 8: the "lists notes..." test, "lets staff add a text note", "surfaces an error...", "lets staff add a todo...", "lets staff log a time entry", "shows a time-tracking total...", "renders a playable audio element...", and "hides the add-note and add-todo forms for non-staff users"). Update the mock block to:

```typescript
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'review_notes') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ order: (...args: unknown[]) => selectNotes(...args) }) }) }),
          insert: (...args: unknown[]) => insertNote(...args),
        };
      }
      if (table === 'review_todos') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ order: (...args: unknown[]) => selectTodos(...args) }) }) }),
          insert: (...args: unknown[]) => insertTodo(...args),
          update: (...args: unknown[]) => {
            updateTodo(...args);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ eq: () => ({ order: (...args: unknown[]) => selectTimeEntries(...args) }) }) }),
        insert: (...args: unknown[]) => insertTimeEntry(...args),
      };
    },
    storage: {
      from: () => ({
        createSignedUrl: (...args: unknown[]) => createSignedUrl(...args),
      }),
    },
  }),
}));
```

For each of the 8 `render(<NotesFeed companyId="company-1" userId="staff-1" isStaff />)` (or `userId="client-1" isStaff={false}`) calls, add `periodId="period-1" isReadOnly={false}` — e.g. the first becomes `render(<NotesFeed companyId="company-1" userId="staff-1" isStaff periodId="period-1" isReadOnly={false} />)`.

Add one new test at the end of the `describe` block:

```typescript
  it('hides all write forms when viewing a read-only (archived) period, even for staff', async () => {
    render(<NotesFeed companyId="company-1" userId="staff-1" isStaff periodId="period-1" isReadOnly />);

    await screen.findByText('Reviewed the July EC2 spike.');
    expect(screen.queryByLabelText(/add a note/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new todo/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/minutes spent/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Run NotesFeed tests, verify pass**

Run: `npx jest components/notes/NotesFeed.test.tsx`
Expected: PASS, including the new read-only test.

- [ ] **Step 4: Update `UploadedFilesList`'s props and query**

In `components/files/UploadedFilesList.tsx`, change the props interface:

```typescript
interface UploadedFilesListProps {
  companyId: string;
  periodId: string;
  isReadOnly: boolean;
}
```

Update the function signature and add `.eq('period_id', periodId)` to the query in `fetchFiles`, adding `periodId` to its dependency array:

```typescript
export default function UploadedFilesList({ companyId, periodId, isReadOnly }: UploadedFilesListProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFiles = useCallback(async (onComplete?: (files: UploadedFile[]) => void) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('uploaded_files')
      .select('*')
      .eq('company_id', companyId)
      .eq('period_id', periodId)
      .order('created_at', { ascending: false });
    const fileList = data ?? [];
    if (onComplete) {
      onComplete(fileList);
    }
    return fileList;
  }, [companyId, periodId]);
```

Change the render to hide `UploadForm` when read-only:

```tsx
  return (
    <div className={styles.wrapper}>
      {!isReadOnly && <UploadForm companyId={companyId} onUploaded={loadFiles} />}
```

- [ ] **Step 5: Update `UploadedFilesList.test.tsx`**

The current mock chain is `select: () => ({ eq: () => ({ order: (...args) => listFiles(...args) }) })` (one `.eq()`). Add a second chained `.eq()`:

```typescript
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: (...args: unknown[]) => listFiles(...args),
          }),
        }),
      }),
    }),
  }),
}));
```

Add `periodId="period-1" isReadOnly={false}` to each of the 3 existing `render(<UploadedFilesList companyId="company-1" />)` calls (in "lists uploaded files with their status", "shows the error message for a failed upload", "shows an empty state when there are no files") — e.g. `render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly={false} />)`.

Add one new test at the end of the `describe` block:

```typescript
  it('hides the upload form when viewing a read-only (archived) period', async () => {
    listFiles.mockResolvedValueOnce({ data: [] });

    render(<UploadedFilesList companyId="company-1" periodId="period-1" isReadOnly />);

    await screen.findByText(/no files uploaded yet/i);
    expect(screen.queryByRole('heading', { name: /upload a billing file/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test` — all pass, including both updated files and the two new read-only tests.

- [ ] **Step 7: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 8: Commit**

```bash
git add components/notes/NotesFeed.tsx components/notes/NotesFeed.test.tsx components/files/UploadedFilesList.tsx components/files/UploadedFilesList.test.tsx
git commit -m "Scope NotesFeed and UploadedFilesList to a period, add read-only mode"
```

---

## Task 5: Hand-author the Table primitive, install @tanstack/react-table

**Files:**
- Create: `components/ui/table.tsx`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils` (existing, from Stage A).
- Produces: `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption` — Task 7 (`LineItemsTab`) consumes these exact names.

- [ ] **Step 1: Install the dependency**

Run: `npm install @tanstack/react-table`

- [ ] **Step 2: Write `components/ui/table.tsx`**

This is the real upstream shadcn "Table" template (classic Radix-era generation, matching Stage A's Button/Tabs/Card/Badge hand-authoring — no Radix primitive needed here, it's plain semantic HTML with Tailwind utility classes):

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  )
);
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} />
  )
);
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn('border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', className)}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0',
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn('p-2 align-middle [&:has([role=checkbox])]:pr-0', className)} {...props} />
  )
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
  )
);
TableCaption.displayName = 'TableCaption';

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption };
```

- [ ] **Step 3: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass (this file has no consumer yet, so nothing should change behaviorally).

- [ ] **Step 4: Commit**

```bash
git add components/ui/table.tsx package.json package-lock.json
git commit -m "Add hand-authored Table primitive, install @tanstack/react-table"
```

---

## Task 6: `lib/lineItemQuery.ts` — paginated query + count helpers (TDD)

**Files:**
- Create: `lib/lineItemQuery.ts`, `lib/lineItemQuery.test.ts`

**Interfaces:**
- Consumes: `CostRecord` type from `@/lib/types` (Task 2), a Supabase client instance (dependency-injected, not created internally — this is what makes it unit-testable without mocking module imports).
- Produces: `LineItemFilters`, `LineItemSort`, `LineItemPage` types; `fetchLineItemsPage(supabase, filters, sort, page)`. Task 8 (`LineItemsTab`) consumes this exact function and its exact type shapes.

- [ ] **Step 1: Write the failing tests**

```typescript
import { fetchLineItemsPage } from './lineItemQuery';

function makeMockSupabase(response: { data: unknown[] | null; count: number | null; error: { message: string } | null }) {
  const range = jest.fn().mockResolvedValue(response);
  const order = jest.fn(() => ({ range }));
  const inFn = jest.fn(() => ({ order }));
  const eq = jest.fn(() => ({ eq, in: inFn, order }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  return { client: { from } as never, range, order, inFn, eq, select, from };
}

describe('fetchLineItemsPage', () => {
  it('returns rows and totalCount from a successful query', async () => {
    const { client, range } = makeMockSupabase({
      data: [{ id: 'r1', service_name: 'Amazon EC2', cost: 10 }],
      count: 42,
      error: null,
    });

    const result = await fetchLineItemsPage(
      client,
      { periodId: 'period-1' },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(result).toEqual({ rows: [{ id: 'r1', service_name: 'Amazon EC2', cost: 10 }], totalCount: 42 });
    expect(range).toHaveBeenCalledWith(0, 49);
  });

  it('computes the correct range for a later page', async () => {
    const { client, range } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1' },
      { column: 'cost', direction: 'asc' },
      { pageIndex: 2, pageSize: 50 }
    );

    expect(range).toHaveBeenCalledWith(100, 149);
  });

  it('applies the service-name filter via .in() when provided', async () => {
    const { client, inFn } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1', serviceNames: ['Amazon EC2', 'Amazon S3'] },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(inFn).toHaveBeenCalledWith('service_name', ['Amazon EC2', 'Amazon S3']);
  });

  it('applies the cloud provider filter via .eq() when provided', async () => {
    const { client, eq } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1', cloudProvider: 'azure' },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(eq).toHaveBeenCalledWith('cloud_provider', 'azure');
  });

  it('throws with the underlying message when the query errors', async () => {
    const { client } = makeMockSupabase({ data: null, count: null, error: { message: 'boom' } });

    await expect(
      fetchLineItemsPage(
        client,
        { periodId: 'period-1' },
        { column: 'usage_date', direction: 'desc' },
        { pageIndex: 0, pageSize: 50 }
      )
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest lib/lineItemQuery.test.ts`
Expected: FAIL — `Cannot find module './lineItemQuery'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudProvider, CostRecord } from './types';

export type LineItemSortColumn = 'usage_date' | 'cost';
export type SortDirection = 'asc' | 'desc';

export interface LineItemFilters {
  periodId: string;
  serviceNames?: string[];
  cloudProvider?: CloudProvider;
}

export interface LineItemSort {
  column: LineItemSortColumn;
  direction: SortDirection;
}

export interface LineItemPageRequest {
  pageIndex: number;
  pageSize: number;
}

export interface LineItemPage {
  rows: CostRecord[];
  totalCount: number;
}

export async function fetchLineItemsPage(
  supabase: SupabaseClient,
  filters: LineItemFilters,
  sort: LineItemSort,
  page: LineItemPageRequest
): Promise<LineItemPage> {
  let query = supabase.from('cost_records').select('*', { count: 'exact' }).eq('period_id', filters.periodId);

  if (filters.cloudProvider) {
    query = query.eq('cloud_provider', filters.cloudProvider);
  }
  if (filters.serviceNames && filters.serviceNames.length > 0) {
    query = query.in('service_name', filters.serviceNames);
  }

  const from = page.pageIndex * page.pageSize;
  const to = from + page.pageSize - 1;

  const { data, count, error } = await query
    .order(sort.column, { ascending: sort.direction === 'asc' })
    .range(from, to);

  if (error) {
    throw new Error(error.message);
  }

  return { rows: (data ?? []) as CostRecord[], totalCount: count ?? 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest lib/lineItemQuery.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/lineItemQuery.ts lib/lineItemQuery.test.ts
git commit -m "Add lib/lineItemQuery.ts: paginated cost_records query for the Line Items tab"
```

---

## Task 7: Referenced-record lookup helper (TDD)

**Files:**
- Modify: `lib/lineItemQuery.ts`, `lib/lineItemQuery.test.ts`

**Interfaces:**
- Consumes: a Supabase client instance (same dependency-injection pattern as Task 6).
- Produces: `fetchReferencedRecordIds(supabase, recordIds)` — Task 8 (`LineItemsTab`) consumes this exact function to compute the "a note/todo already references this row" indicator, without joining it into the main paginated query.

- [ ] **Step 1: Write the failing test**

Add to `lib/lineItemQuery.test.ts`:

```typescript
import { fetchLineItemsPage, fetchReferencedRecordIds } from './lineItemQuery';

// ... (existing describe block for fetchLineItemsPage stays as-is; add a new describe block below it)

describe('fetchReferencedRecordIds', () => {
  function makeMockSupabaseForReferences(notesIds: string[], todosIds: string[]) {
    const from = jest.fn((table: string) => ({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: (table === 'review_notes' ? notesIds : todosIds).map((cost_record_id) => ({ cost_record_id })),
            error: null,
          }),
      }),
    }));
    return { from } as never;
  }

  it('returns the union of cost_record_ids referenced by notes and todos', async () => {
    const client = makeMockSupabaseForReferences(['r1', 'r2'], ['r2', 'r3']);

    const result = await fetchReferencedRecordIds(client, ['r1', 'r2', 'r3', 'r4']);

    expect(result).toEqual(new Set(['r1', 'r2', 'r3']));
  });

  it('returns an empty set when given no record ids', async () => {
    const client = makeMockSupabaseForReferences([], []);

    const result = await fetchReferencedRecordIds(client, []);

    expect(result).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest lib/lineItemQuery.test.ts`
Expected: FAIL — `fetchReferencedRecordIds is not a function` (or similar import error).

- [ ] **Step 3: Add the implementation**

Append to `lib/lineItemQuery.ts`:

```typescript
export async function fetchReferencedRecordIds(
  supabase: SupabaseClient,
  recordIds: string[]
): Promise<Set<string>> {
  if (recordIds.length === 0) {
    return new Set();
  }

  const [notesResult, todosResult] = await Promise.all([
    supabase.from('review_notes').select('cost_record_id').in('cost_record_id', recordIds),
    supabase.from('review_todos').select('cost_record_id').in('cost_record_id', recordIds),
  ]);

  const referenced = new Set<string>();
  for (const row of notesResult.data ?? []) {
    if (row.cost_record_id) referenced.add(row.cost_record_id);
  }
  for (const row of todosResult.data ?? []) {
    if (row.cost_record_id) referenced.add(row.cost_record_id);
  }
  return referenced;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest lib/lineItemQuery.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/lineItemQuery.ts lib/lineItemQuery.test.ts
git commit -m "Add fetchReferencedRecordIds for the Line Items note/todo indicator"
```

---

## Task 8: LineItemsTab

**Files:**
- Create: `components/reports/LineItemsTab.tsx`, `components/reports/LineItemsTab.test.tsx`

**Interfaces:**
- Consumes: `fetchLineItemsPage`, `fetchReferencedRecordIds` (Tasks 6-7); `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` (Task 5); `@tanstack/react-table`'s `useReactTable`, `getCoreRowModel`, `flexRender`, `createColumnHelper`.
- Produces: `LineItemsTab` — props `{ companyId: string; periodId: string; initialServiceFilter?: string[] }`. Task 10 (AppShell) renders this with a `key` derived from `initialServiceFilter` so a new drill-down target forces a fresh mount.

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { fetchLineItemsPage, fetchReferencedRecordIds, type LineItemSortColumn } from '@/lib/lineItemQuery';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import styles from './LineItemsTab.module.css';

interface LineItemsTabProps {
  companyId: string;
  periodId: string;
  initialServiceFilter?: string[];
}

const PAGE_SIZE = 50;

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

const columnHelper = createColumnHelper<CostRecord & { referenced: boolean }>();

const columns = [
  columnHelper.accessor('usage_date', { header: 'Date', cell: (info) => info.getValue() }),
  columnHelper.accessor('cloud_provider', {
    header: 'Provider',
    cell: (info) => (info.getValue() === 'aws' ? 'AWS' : 'Azure'),
  }),
  columnHelper.accessor('service_name', { header: 'Service', cell: (info) => info.getValue() }),
  columnHelper.accessor('account_id', { header: 'Account', cell: (info) => info.getValue() ?? '—' }),
  columnHelper.accessor('cost', { header: 'Cost', cell: (info) => formatCurrency(info.getValue()) }),
  columnHelper.accessor('referenced', {
    header: '',
    cell: (info) => (info.getValue() ? <span title="Referenced by a note or follow-up">📝</span> : null),
  }),
];

export default function LineItemsTab({ companyId, periodId, initialServiceFilter }: LineItemsTabProps) {
  const [rows, setRows] = useState<CostRecord[]>([]);
  const [referencedIds, setReferencedIds] = useState<Set<string>>(new Set());
  const [totalCount, setTotalCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortColumn, setSortColumn] = useState<LineItemSortColumn>('usage_date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [serviceFilter, setServiceFilter] = useState<string[]>(initialServiceFilter ?? []);
  const [providerFilter, setProviderFilter] = useState<CloudProvider | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();

      try {
        const page = await fetchLineItemsPage(
          supabase,
          {
            periodId,
            serviceNames: serviceFilter.length > 0 ? serviceFilter : undefined,
            cloudProvider: providerFilter || undefined,
          },
          { column: sortColumn, direction: sortDirection },
          { pageIndex, pageSize: PAGE_SIZE }
        );
        if (cancelled) return;

        const referenced = await fetchReferencedRecordIds(supabase, page.rows.map((row) => row.id));
        if (cancelled) return;

        setRows(page.rows);
        setTotalCount(page.totalCount);
        setReferencedIds(referenced);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load line items.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, periodId, serviceFilter, providerFilter, sortColumn, sortDirection, pageIndex]);

  const tableRows = useMemo(
    () => rows.map((row) => ({ ...row, referenced: referencedIds.has(row.id) })),
    [rows, referencedIds]
  );

  const table = useReactTable({
    data: tableRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  function toggleSort(column: LineItemSortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
    setPageIndex(0);
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <label htmlFor="line-items-provider">Provider</label>
        <select
          id="line-items-provider"
          value={providerFilter}
          onChange={(e) => {
            setProviderFilter(e.target.value as CloudProvider | '');
            setPageIndex(0);
          }}
        >
          <option value="">All</option>
          <option value="aws">AWS</option>
          <option value="azure">Azure</option>
        </select>
        {serviceFilter.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setServiceFilter([]);
              setPageIndex(0);
            }}
          >
            Clear service filter ({serviceFilter.length})
          </button>
        )}
        <button type="button" onClick={() => toggleSort('usage_date')}>
          Sort by date {sortColumn === 'usage_date' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
        </button>
        <button type="button" onClick={() => toggleSort('cost')}>
          Sort by cost {sortColumn === 'cost' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p>No line items match this filter.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className={styles.pagination}>
            <button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex((p) => p - 1)}>
              Previous
            </button>
            <span>
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              type="button"
              disabled={pageIndex + 1 >= pageCount}
              onClick={() => setPageIndex((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `LineItemsTab.module.css`**

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.error {
  color: var(--color-destructive, #d1274b);
}
```

(Check whether `--color-destructive` exists in `app/globals.css` — Stage A introduced `--destructive` as a shadcn token, not `--color-destructive`; if `--color-destructive` isn't defined, use the literal `#d1274b` alone, matching this project's existing canonical error-red value from other CSS Modules, e.g. `AdminUsers.module.css`.)

- [ ] **Step 3: Write the test**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LineItemsTab from './LineItemsTab';

const fetchPage = jest.fn();
const fetchReferenced = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}));

jest.mock('@/lib/lineItemQuery', () => ({
  fetchLineItemsPage: (...args: unknown[]) => fetchPage(...args),
  fetchReferencedRecordIds: (...args: unknown[]) => fetchReferenced(...args),
}));

describe('LineItemsTab', () => {
  beforeEach(() => {
    fetchPage.mockReset();
    fetchReferenced.mockReset();
    fetchReferenced.mockResolvedValue(new Set());
  });

  it('shows a page of line items with totals and pagination info', async () => {
    fetchPage.mockResolvedValueOnce({
      rows: [
        { id: 'r1', company_id: 'c1', period_id: 'p1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 12.5, account_id: null, source_file_id: 'f1', created_at: '2026-08-01T00:00:00.000Z' },
      ],
      totalCount: 120,
    });

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    expect(await screen.findByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('shows the note/todo indicator for a referenced row', async () => {
    fetchPage.mockResolvedValueOnce({
      rows: [
        { id: 'r1', company_id: 'c1', period_id: 'p1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 12.5, account_id: null, source_file_id: 'f1', created_at: '2026-08-01T00:00:00.000Z' },
      ],
      totalCount: 1,
    });
    fetchReferenced.mockResolvedValueOnce(new Set(['r1']));

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    await screen.findByText('Amazon EC2');
    expect(screen.getByTitle('Referenced by a note or follow-up')).toBeInTheDocument();
  });

  it('re-fetches with the initial service filter when provided', async () => {
    fetchPage.mockResolvedValue({ rows: [], totalCount: 0 });

    render(<LineItemsTab companyId="c1" periodId="p1" initialServiceFilter={['Amazon EC2']} />);

    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchPage.mock.calls[0][1]).toMatchObject({ serviceNames: ['Amazon EC2'] });
  });

  it('clicking a sort button toggles direction and re-fetches', async () => {
    fetchPage.mockResolvedValue({ rows: [], totalCount: 0 });
    const user = userEvent.setup();

    render(<LineItemsTab companyId="c1" periodId="p1" />);

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /sort by cost/i }));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[1][2]).toEqual({ column: 'cost', direction: 'desc' });
  });
});
```

- [ ] **Step 4: Run to verify it fails, then passes**

Run: `npx jest components/reports/LineItemsTab.test.tsx -v` before writing the implementation (Step 1) — confirm it fails with a module-not-found error, matching TDD. Then, after Steps 1-3 are in place: run again.
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 6: Commit**

```bash
git add components/reports/LineItemsTab.tsx components/reports/LineItemsTab.module.css components/reports/LineItemsTab.test.tsx
git commit -m "Add LineItemsTab: sortable, server-side-paginated cost_records table"
```

---

## Task 9: TrendSidebar

**Files:**
- Create: `components/reports/TrendSidebar.tsx`, `components/reports/TrendSidebar.module.css`, `components/reports/TrendSidebar.test.tsx`

**Interfaces:**
- Consumes: `public.monthly_cost_by_provider` view (Task 1).
- Produces: `TrendSidebar` — props `{ companyId: string }`. Task 10 (AppShell) renders this once, alongside whichever report tab is active.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import TrendSidebar from './TrendSidebar';

const loadTrend = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: (...args: unknown[]) => loadTrend(...args),
        }),
      }),
    }),
  }),
}));

jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy({}, { get: () => Passthrough });
});

describe('TrendSidebar', () => {
  beforeEach(() => {
    loadTrend.mockReset();
  });

  it('shows trailing-12-month totals per provider', async () => {
    loadTrend.mockResolvedValueOnce({
      data: [
        { month: '2026-07-01', cloud_provider: 'aws', total: 100 },
        { month: '2026-07-01', cloud_provider: 'azure', total: 40 },
        { month: '2026-08-01', cloud_provider: 'aws', total: 120 },
      ],
    });

    render(<TrendSidebar companyId="company-1" />);

    expect(await screen.findByText('$120.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();
  });

  it('shows an empty state when there is no trend data', async () => {
    loadTrend.mockResolvedValueOnce({ data: [] });

    render(<TrendSidebar companyId="company-1" />);

    expect(await screen.findByText(/no trend data yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest components/reports/TrendSidebar.test.tsx`
Expected: FAIL — `Cannot find module './TrendSidebar'`.

- [ ] **Step 3: Write the component**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider } from '@/lib/types';
import styles from './TrendSidebar.module.css';

interface TrendSidebarProps {
  companyId: string;
}

interface MonthlyTotal {
  month: string;
  cloud_provider: CloudProvider;
  total: number;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function TrendSidebar({ companyId }: TrendSidebarProps) {
  const [rows, setRows] = useState<MonthlyTotal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('monthly_cost_by_provider')
        .select('*')
        .eq('company_id', companyId)
        .order('month', { ascending: true });
      if (!cancelled) {
        setRows((data ?? []) as MonthlyTotal[]);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const chartData = useMemo(() => {
    const byMonth = new Map<string, { month: string; aws: number; azure: number }>();
    for (const row of rows) {
      const entry = byMonth.get(row.month) ?? { month: row.month, aws: 0, azure: 0 };
      entry[row.cloud_provider] = row.total;
      byMonth.set(row.month, entry);
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [rows]);

  if (loading) {
    return <p>Loading…</p>;
  }

  if (rows.length === 0) {
    return <p>No trend data yet.</p>;
  }

  return (
    <aside className={styles.wrapper}>
      <h3>12-month trend</h3>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData}>
            <XAxis dataKey="month" hide />
            <YAxis hide />
            <Tooltip />
            <Line type="monotone" dataKey="aws" stroke="var(--primary)" name="AWS" dot={false} />
            <Line type="monotone" dataKey="azure" stroke="var(--muted-foreground)" name="Azure" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className={styles.list}>
        {chartData.map((entry) => (
          <li key={entry.month}>
            <span>{entry.month}</span>
            <span>AWS {formatCurrency(entry.aws)}</span>
            <span>Azure {formatCurrency(entry.azure)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 4: Write `TrendSidebar.module.css`**

```css
.wrapper {
  width: 220px;
  flex-shrink: 0;
  padding: 1rem;
  border-radius: var(--radius-pill, 0.5rem);
  background: var(--color-bg-alt);
}

.chart {
  margin-bottom: 0.75rem;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.8rem;
}

.list li {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx jest components/reports/TrendSidebar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` — all pass.

- [ ] **Step 7: Commit**

```bash
git add components/reports/TrendSidebar.tsx components/reports/TrendSidebar.module.css components/reports/TrendSidebar.test.tsx
git commit -m "Add TrendSidebar: 12-month AWS/Azure trend"
```

---

## Task 10: Rewrite CostReportTab/CompareTab around periods, add Archive tab, wire it all into AppShell

This task is intentionally large and covers what would otherwise be two tightly-coupled tasks: rewriting `CostReportTab`/`CompareTab` to require a `periodId` prop makes `AppShell` (their only caller) fail to typecheck until `AppShell` is updated to pass one — there is no way to ship the prop-signature change and the caller update as separately-reviewable, independently-green-build tasks. This task's own step-by-step structure still separates the two concerns clearly (Part A: report components; Part B: Archive tab + AppShell wiring) so it can be reviewed in two mental passes even though it's one commit-and-review unit — but only the *final* pipeline run/commit at the end of Part B counts as this task's actual completion gate. Do not stop and consider the task done after Part A alone; `tsc`/tests will not be green until Part B is also complete.

**Files:**
- Modify: `components/reports/CostReportTab.tsx`, `components/reports/CostReportTab.test.tsx`, `components/reports/CompareTab.tsx`, `components/reports/CompareTab.test.tsx`, `app/globals.css`, `components/shell/AppShell.tsx`, `components/shell/AppShell.test.tsx`, `components/shell/AppShell.module.css`
- Create: `components/shell/ArchiveTab.tsx`, `components/shell/ArchiveTab.test.tsx`, `components/shell/ArchiveTab.module.css`
- Delete: `components/reports/DateRangePicker.tsx`, `components/reports/DateRangePicker.test.tsx`, `components/reports/DateRangePicker.module.css`, `lib/dateRange.ts`, `lib/dateRange.test.ts`

**Interfaces:**
- Consumes: `TrendSidebar` (Task 9), `LineItemsTab` (Task 8), `NotesFeed`/`UploadedFilesList`'s `periodId`/`isReadOnly` props (Task 4), `POST /api/periods/archive` (Task 3), `BillingPeriod` type (Task 2).
- Produces: `CostReportTab` gains `periodId: string` (replacing its internal granularity/date-range state) and `onServiceClick?: (serviceName: string) => void`; `CompareTab` gains `periodId: string` and `onCategoryClick?: (serviceNames: string[]) => void`. `AppShell`'s own props are unchanged (`userId`, `role`, `companyId`) — no later task depends on anything new from `AppShell` itself.

### Part A: CostReportTab and CompareTab

- [ ] **Step 1: Confirm `DateRangePicker`/`lib/dateRange` have no other consumers**

Run: `grep -rn "DateRangePicker\|dateRange" --include="*.tsx" --include="*.ts" components lib app | grep -v ".test."`
Expected: only `CostReportTab.tsx` and `CompareTab.tsx` reference them (confirmed already during this plan's research — re-verify it's still true before deleting).

- [ ] **Step 2: Rewrite `CostReportTab.tsx`**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { aggregateByDate, aggregateByService, totalCost } from '@/lib/reportAggregation';
import styles from './CostReportTab.module.css';

interface CostReportTabProps {
  companyId: string;
  cloudProvider: CloudProvider;
  periodId: string;
  onServiceClick?: (serviceName: string) => void;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CostReportTab({ companyId, cloudProvider, periodId, onServiceClick }: CostReportTabProps) {
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();
      const pageSize = 1000;
      const allRows: CostRecord[] = [];
      let offset = 0;

      // PostgREST caps rows per request (commonly 1000), so page through until a
      // short page tells us we've reached the end — otherwise large result sets
      // would be silently truncated.
      for (;;) {
        const { data, error: pageError } = await supabase
          .from('cost_records')
          .select('*')
          .eq('company_id', companyId)
          .eq('cloud_provider', cloudProvider)
          .eq('period_id', periodId)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (pageError) {
          if (!cancelled) {
            setError('Could not load cost data. Please try again.');
            setLoading(false);
          }
          return;
        }

        const page = data ?? [];
        allRows.push(...page);

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      if (!cancelled) {
        setRecords(allRows);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, cloudProvider, periodId]);

  const byDate = useMemo(() => aggregateByDate(records), [records]);
  const byService = useMemo(() => aggregateByService(records), [records]);
  const total = useMemo(() => totalCost(records), [records]);

  return (
    <div className={styles.wrapper}>
      <button type="button" className={`${styles.printButton} print-hidden`} onClick={() => window.print()}>
        Print
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : records.length === 0 ? (
        <p>No cost data for this period.</p>
      ) : (
        <>
          <p className={styles.total}>{formatCurrency(total)}</p>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={byDate}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Line type="monotone" dataKey="total" name="Daily total" stroke="var(--primary)" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={byService}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="service_name" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar
                  dataKey="total"
                  name="Cost by service"
                  fill="var(--primary)"
                  onClick={(data) => onServiceClick?.(data.service_name)}
                  cursor={onServiceClick ? 'pointer' : undefined}
                />
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

- [ ] **Step 3: Update `CostReportTab.test.tsx`**

Read the current file in full first. Update the mock chain (one fewer level — no more `.gte()`/`.lte()`, and `.eq()` is called 3 times now: `company_id`, `cloud_provider`, `period_id`):

```tsx
import { render, screen } from '@testing-library/react';
import CostReportTab from './CostReportTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                range: (...args: unknown[]) => loadRecords(...args),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

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

  it('shows the total cost and a per-service breakdown for the period', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
      ],
    });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('Amazon EC2')).toBeInTheDocument();
    expect(screen.getByText('Amazon S3')).toBeInTheDocument();
  });

  it('shows an empty state when there are no records in the period', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" periodId="period-1" />);

    expect(await screen.findByText(/no cost data for this period/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewrite `CompareTab.tsx`**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CostRecord } from '@/lib/types';
import { aggregateByCategoryComparison, totalCost } from '@/lib/reportAggregation';
import { categorizeService } from '@/lib/serviceCategory';
import styles from './CompareTab.module.css';

interface CompareTabProps {
  companyId: string;
  periodId: string;
  onCategoryClick?: (serviceNames: string[]) => void;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CompareTab({ companyId, periodId, onCategoryClick }: CompareTabProps) {
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const supabase = createClient();
      const pageSize = 1000;
      const allRows: CostRecord[] = [];
      let offset = 0;

      // PostgREST caps rows per request (commonly 1000), so page through until a
      // short page tells us we've reached the end — otherwise large result sets
      // would be silently truncated.
      for (;;) {
        const { data, error: pageError } = await supabase
          .from('cost_records')
          .select('*')
          .eq('company_id', companyId)
          .eq('period_id', periodId)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (pageError) {
          if (!cancelled) {
            setError('Could not load cost data. Please try again.');
            setLoading(false);
          }
          return;
        }

        const page = data ?? [];
        allRows.push(...page);

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      if (!cancelled) {
        setRecords(allRows);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, periodId]);

  const awsRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'aws'), [records]);
  const azureRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'azure'), [records]);
  const awsTotal = useMemo(() => totalCost(awsRecords), [awsRecords]);
  const azureTotal = useMemo(() => totalCost(azureRecords), [azureRecords]);
  const categoryComparison = useMemo(
    () => aggregateByCategoryComparison(records, categorizeService),
    [records]
  );

  function handleCategoryClick(category: string) {
    if (!onCategoryClick) return;
    const serviceNames = Array.from(
      new Set(records.filter((r) => categorizeService(r.service_name) === category).map((r) => r.service_name))
    );
    onCategoryClick(serviceNames);
  }

  return (
    <div className={styles.wrapper}>
      <button type="button" className={`${styles.printButton} print-hidden`} onClick={() => window.print()}>
        Print
      </button>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : records.length === 0 ? (
        <p>No cost data for this period.</p>
      ) : (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <h3>AWS</h3>
              <p className={styles.total}>{formatCurrency(awsTotal)}</p>
            </div>
            <div className={styles.card}>
              <h3>Azure</h3>
              <p className={styles.total}>{formatCurrency(azureTotal)}</p>
            </div>
          </div>

          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={categoryComparison}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="category" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar
                  dataKey="aws"
                  name="AWS"
                  fill="var(--primary)"
                  onClick={(data) => handleCategoryClick(data.category)}
                  cursor={onCategoryClick ? 'pointer' : undefined}
                />
                <Bar
                  dataKey="azure"
                  name="Azure"
                  fill="var(--muted-foreground)"
                  onClick={(data) => handleCategoryClick(data.category)}
                  cursor={onCategoryClick ? 'pointer' : undefined}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Category</th>
                <th>AWS</th>
                <th>Azure</th>
              </tr>
            </thead>
            <tbody>
              {categoryComparison.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td>{formatCurrency(row.aws)}</td>
                  <td>{formatCurrency(row.azure)}</td>
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

- [ ] **Step 6: Update `CompareTab.test.tsx`**

Update the mock chain (2 `.eq()` calls now — `company_id`, `period_id` — no more `.gte()`/`.lte()`):

```tsx
import { render, screen } from '@testing-library/react';
import CompareTab from './CompareTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              range: (...args: unknown[]) => loadRecords(...args),
            }),
          }),
        }),
      }),
    }),
  }),
}));

jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return new Proxy(
    {},
    {
      get: () => Passthrough,
    }
  );
});

describe('CompareTab', () => {
  beforeEach(() => {
    loadRecords.mockReset();
  });

  it('shows separate AWS and Azure totals for the period', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
        { id: 'r3', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
      ],
    });

    render(<CompareTab companyId="company-1" periodId="period-1" />);

    const awsHeading = await screen.findByRole('heading', { name: 'AWS' });
    const awsCard = awsHeading.closest('.card');
    expect(awsCard).not.toBeNull();
    expect(awsCard as HTMLElement).toHaveTextContent('$15.00');

    const azureHeading = screen.getByRole('heading', { name: 'Azure' });
    const azureCard = azureHeading.closest('.card');
    expect(azureCard).not.toBeNull();
    expect(azureCard as HTMLElement).toHaveTextContent('$8.00');
  });

  it('shows a category-level breakdown table for overlapping service types', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
        { id: 'r3', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 3 },
      ],
    });

    render(<CompareTab companyId="company-1" periodId="period-1" />);

    expect(await screen.findByText('Compute')).toBeInTheDocument();
    expect(screen.getByText('Storage')).toBeInTheDocument();

    const computeRow = screen.getByText('Compute').closest('tr');
    expect(computeRow).not.toBeNull();
    expect(computeRow as HTMLElement).toHaveTextContent('$10.00');
    expect(computeRow as HTMLElement).toHaveTextContent('$8.00');

    const storageRow = screen.getByText('Storage').closest('tr');
    expect(storageRow).not.toBeNull();
    expect(storageRow as HTMLElement).toHaveTextContent('$3.00');
    expect(storageRow as HTMLElement).toHaveTextContent('$0.00');
  });
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest components/reports/CompareTab.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 8: Add the shared print stylesheet**

In `app/globals.css`, add at the end of the file:

```css
@media print {
  .print-hidden {
    display: none !important;
  }
}
```

- [ ] **Step 9: Delete the now-unused Day/Week/Month files**

```bash
git rm components/reports/DateRangePicker.tsx components/reports/DateRangePicker.test.tsx components/reports/DateRangePicker.module.css lib/dateRange.ts lib/dateRange.test.ts
```

Do not run the full pipeline or commit yet — `AppShell.tsx` still calls `CostReportTab`/`CompareTab` with their old props at this point, so `tsc`/`build` will fail until Part B (below) also lands. Continue directly into Part B.

### Part B: Archive tab and AppShell wiring

- [ ] **Step 10: Write `ArchiveTab.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { BillingPeriod } from '@/lib/types';
import styles from './ArchiveTab.module.css';

interface ArchiveTabProps {
  companyId: string;
  onSelectPeriod: (periodId: string) => void;
}

export default function ArchiveTab({ companyId, onSelectPeriod }: ArchiveTabProps) {
  const [periods, setPeriods] = useState<(BillingPeriod & { label: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data: archivedPeriods } = await supabase
        .from('billing_periods')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'archived')
        .order('archived_at', { ascending: false });

      const periodsWithLabels = await Promise.all(
        (archivedPeriods ?? []).map(async (period: BillingPeriod) => {
          const { data: range } = await supabase
            .from('cost_records')
            .select('usage_date')
            .eq('period_id', period.id)
            .order('usage_date', { ascending: true })
            .limit(1)
            .maybeSingle();
          const { data: rangeEnd } = await supabase
            .from('cost_records')
            .select('usage_date')
            .eq('period_id', period.id)
            .order('usage_date', { ascending: false })
            .limit(1)
            .maybeSingle();

          const label =
            range && rangeEnd
              ? range.usage_date === rangeEnd.usage_date
                ? range.usage_date
                : `${range.usage_date} – ${rangeEnd.usage_date}`
              : 'No data';

          return { ...period, label };
        })
      );

      if (!cancelled) {
        setPeriods(periodsWithLabels);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (loading) {
    return <p>Loading…</p>;
  }

  if (periods.length === 0) {
    return <p>No archived periods yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {periods.map((period) => (
        <li key={period.id}>
          <button type="button" onClick={() => onSelectPeriod(period.id)}>
            {period.label}
          </button>
          <span className={styles.archivedAt}>
            Archived {period.archived_at ? new Date(period.archived_at).toLocaleDateString() : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 11: Write `ArchiveTab.module.css`**

```css
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.list li {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.archivedAt {
  color: var(--color-muted-foreground, var(--color-fg));
  font-size: 0.85rem;
}
```

- [ ] **Step 12: Write `ArchiveTab.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ArchiveTab from './ArchiveTab';

const loadPeriods = jest.fn();
const loadRangeStart = jest.fn();
const loadRangeEnd = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'billing_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: (...args: unknown[]) => loadPeriods(...args),
              }),
            }),
          }),
        };
      }
      let ascending = true;
      return {
        select: () => ({
          eq: () => ({
            order: (_col: string, opts: { ascending: boolean }) => {
              ascending = opts.ascending;
              return {
                limit: () => ({
                  maybeSingle: () => (ascending ? loadRangeStart() : loadRangeEnd()),
                }),
              };
            },
          }),
        }),
      };
    },
  }),
}));

describe('ArchiveTab', () => {
  beforeEach(() => {
    loadPeriods.mockReset();
    loadRangeStart.mockReset();
    loadRangeEnd.mockReset();
    loadRangeStart.mockResolvedValue({ data: { usage_date: '2026-07-01' } });
    loadRangeEnd.mockResolvedValue({ data: { usage_date: '2026-07-31' } });
  });

  it('lists archived periods with a computed date-range label', async () => {
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });

    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    expect(await screen.findByText('2026-07-01 – 2026-07-31')).toBeInTheDocument();
  });

  it('calls onSelectPeriod with the period id when clicked', async () => {
    loadPeriods.mockResolvedValueOnce({
      data: [
        { id: 'p1', company_id: 'c1', status: 'archived', created_at: '2026-07-01T00:00:00.000Z', archived_at: '2026-08-01T00:00:00.000Z' },
      ],
    });
    const onSelectPeriod = jest.fn();
    const user = userEvent.setup();

    render(<ArchiveTab companyId="c1" onSelectPeriod={onSelectPeriod} />);

    await user.click(await screen.findByRole('button', { name: '2026-07-01 – 2026-07-31' }));
    expect(onSelectPeriod).toHaveBeenCalledWith('p1');
  });

  it('shows an empty state with no archived periods', async () => {
    loadPeriods.mockResolvedValueOnce({ data: [] });

    render(<ArchiveTab companyId="c1" onSelectPeriod={jest.fn()} />);

    expect(await screen.findByText(/no archived periods yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Run to verify it passes**

Run: `npx jest components/shell/ArchiveTab.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 14: Read the current `AppShell.tsx` and `AppShell.test.tsx` in full**

This file has been modified in every prior stage — confirm its exact current state before editing (it currently has `activeTab`, `companies`, `selectedCompanyId` state and the tab list from Stage A: `aws|azure|compare|files|notes|admin`).

- [ ] **Step 15: Rewrite `AppShell.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Company, ProfileRole } from '@/lib/types';
import UploadedFilesList from '../files/UploadedFilesList';
import CostReportTab from '../reports/CostReportTab';
import CompareTab from '../reports/CompareTab';
import LineItemsTab from '../reports/LineItemsTab';
import TrendSidebar from '../reports/TrendSidebar';
import NotesFeed from '../notes/NotesFeed';
import AdminCompanies from '../admin/AdminCompanies';
import AdminUsers from '../admin/AdminUsers';
import ArchiveTab from './ArchiveTab';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';
import styles from './AppShell.module.css';

type TabKey = 'aws' | 'azure' | 'compare' | 'lineItems' | 'files' | 'notes' | 'archive' | 'admin';

const REPORT_TABS: TabKey[] = ['aws', 'azure', 'compare', 'lineItems'];

interface AppShellProps {
  userId: string;
  role: ProfileRole;
  companyId: string | null;
}

export default function AppShell({ userId, role, companyId }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('aws');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(companyId);
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [viewingPeriodId, setViewingPeriodId] = useState<string | null>(null);
  const [lineItemsFilter, setLineItemsFilter] = useState<string[] | undefined>(undefined);
  const router = useRouter();

  useEffect(() => {
    if (role !== 'staff') return;

    let cancelled = false;

    async function loadCompanies() {
      const supabase = createClient();
      const { data } = await supabase.from('companies').select('*').order('name', { ascending: true });
      if (cancelled) return;
      setCompanies(data ?? []);
      if (data && data.length > 0) {
        setSelectedCompanyId((prev) => prev ?? data[0].id);
      }
    }

    loadCompanies();
    return () => {
      cancelled = true;
    };
  }, [role]);

  const effectiveCompanyId = role === 'staff' ? selectedCompanyId : companyId;

  // Switching companies always resets back to that company's active period —
  // never carries over "viewing an archived period" from the previous company.
  useEffect(() => {
    setViewingPeriodId(null);
    setActivePeriodId(null);
    if (!effectiveCompanyId) return;

    let cancelled = false;

    async function loadActivePeriod() {
      const supabase = createClient();
      const { data } = await supabase
        .from('billing_periods')
        .select('id')
        .eq('company_id', effectiveCompanyId)
        .eq('status', 'active')
        .single();
      if (!cancelled) {
        setActivePeriodId(data?.id ?? null);
      }
    }

    loadActivePeriod();
    return () => {
      cancelled = true;
    };
  }, [effectiveCompanyId]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
  }

  async function handleArchive() {
    if (!effectiveCompanyId) return;
    const confirmed = window.confirm(
      'Archive this period? It will be frozen (read-only) and a new empty period will start.'
    );
    if (!confirmed) return;

    const response = await fetch('/api/periods/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: effectiveCompanyId }),
    });
    if (response.ok) {
      const body = await response.json();
      setActivePeriodId(body.newPeriodId);
    }
  }

  function handleServiceDrillDown(serviceNames: string[]) {
    setLineItemsFilter(serviceNames);
    setActiveTab('lineItems');
  }

  const viewingArchivedPeriod = viewingPeriodId !== null && viewingPeriodId !== activePeriodId;
  const periodIdForReports = viewingArchivedPeriod ? viewingPeriodId : activePeriodId;

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.topBar} print-hidden`}>
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
        {!viewingArchivedPeriod && activePeriodId && (
          <Button type="button" variant="outline" size="sm" onClick={handleArchive}>
            Archive this period
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
        <ThemeToggle />
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)} className={`mb-6 print-hidden`}>
        <TabsList>
          <TabsTrigger value="aws">AWS</TabsTrigger>
          <TabsTrigger value="azure">Azure</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="lineItems">Line Items</TabsTrigger>
          <TabsTrigger value="files">Uploaded Files</TabsTrigger>
          <TabsTrigger value="notes">Notes & Follow-ups</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
          {role === 'staff' && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
      </Tabs>

      {viewingArchivedPeriod && (
        <div className={styles.archiveBanner}>
          <span>Viewing archived period</span>
          <button type="button" onClick={() => setViewingPeriodId(null)}>
            Back to current
          </button>
        </div>
      )}

      <div className={styles.panel}>
        {activeTab === 'admin' && role === 'staff' ? (
          <div className={styles.adminSections}>
            <AdminCompanies />
            <AdminUsers />
          </div>
        ) : activeTab === 'archive' ? (
          effectiveCompanyId ? (
            <ArchiveTab
              companyId={effectiveCompanyId}
              onSelectPeriod={(periodId) => {
                setViewingPeriodId(periodId);
                setActiveTab('aws');
              }}
            />
          ) : (
            <p>Select a company to view its data.</p>
          )
        ) : !effectiveCompanyId ? (
          <p>Select a company to view its data.</p>
        ) : !periodIdForReports ? (
          <p>Loading…</p>
        ) : (
          <div className={REPORT_TABS.includes(activeTab) ? styles.reportLayout : undefined}>
            {REPORT_TABS.includes(activeTab) && (
              <TrendSidebar key={effectiveCompanyId} companyId={effectiveCompanyId} />
            )}
            <div className={styles.reportContent}>
              {activeTab === 'aws' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="aws"
                  periodId={periodIdForReports}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'azure' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="azure"
                  periodId={periodIdForReports}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'compare' && (
                <CompareTab
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  onCategoryClick={handleServiceDrillDown}
                />
              )}
              {activeTab === 'lineItems' && (
                <LineItemsTab
                  key={JSON.stringify(lineItemsFilter)}
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  initialServiceFilter={lineItemsFilter}
                />
              )}
              {activeTab === 'files' && (
                <UploadedFilesList
                  companyId={effectiveCompanyId}
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                />
              )}
              {activeTab === 'notes' && (
                <NotesFeed
                  companyId={effectiveCompanyId}
                  userId={userId}
                  isStaff={role === 'staff'}
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 16: Add layout CSS for the sidebar + banner**

In `AppShell.module.css`, add:

```css
.reportLayout {
  display: flex;
  gap: 1.5rem;
  align-items: flex-start;
}

.reportContent {
  flex: 1;
  min-width: 0;
}

.archiveBanner {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  margin-bottom: 1rem;
  border-radius: var(--radius-pill, 0.5rem);
  background: var(--color-bg-alt);
}
```

- [ ] **Step 17: Update `AppShell.test.tsx`**

Three things break every existing test in this file if not handled, all because `AppShell` now always loads the company's active period asynchronously before rendering any report tab's content, and always renders `TrendSidebar` alongside an active report tab:

1. The company-list mock (`from: () => ({ select: () => ({ order: (...args) => listCompanies(...args) }) })`) is unconditional — it doesn't branch on table name at all today, because there was only ever one query. It now needs to branch: `companies` gets the existing chain, `billing_periods` gets a new `.select().eq().eq().single()` chain that must resolve to `{ data: { id: 'period-1' } }` by default (in `beforeEach`), or `periodIdForReports` stays null and every test sees "Loading…" instead of the mocked tab content.
2. `TrendSidebar`, `LineItemsTab`, and `ArchiveTab` are new real components this test file doesn't yet mock. `TrendSidebar` in particular renders unconditionally alongside every report tab (the default active tab is `aws`) and would otherwise make a real, unmocked `.from('monthly_cost_by_provider')` call the instant any test renders `AppShell` — breaking every existing test. Mock all three as simple stubs, matching this file's existing convention for `CostReportTab`/`CompareTab`/`NotesFeed`/`AdminCompanies`/`AdminUsers`.
3. **This is the subtle one:** the active-period lookup is a real `await`-ed Supabase call, resolving on a microtask tick after the initial render commits — there was no such async gap before this stage (the old code rendered whichever tab's component immediately, synchronously). The very first test in this file (`'shows the AWS tab...'`) asserts on panel content with synchronous `screen.getByText(...)` immediately after `render(...)`, with no intervening `await` — that assertion will now run before the mocked period lookup's promise has resolved, and fail. Every assertion that targets *panel content* (i.e., what's gated behind `periodIdForReports`, not the tab bar or top bar) needs to become `await screen.findByText(...)` / `findByRole(...)` instead of the synchronous `getBy*` form. Assertions on the tab bar itself (`getByRole('tab', ...)`) and the top bar (sign-out button, company switcher) are unaffected — those render unconditionally, not gated by the period lookup.

Replace the entire file with:

```tsx
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
jest.mock('./../reports/CompareTab', () => ({
  __esModule: true,
  default: () => <div>compare-tab-content</div>,
}));
jest.mock('./../reports/LineItemsTab', () => ({
  __esModule: true,
  default: () => <div>line-items-tab-content</div>,
}));
jest.mock('./../reports/TrendSidebar', () => ({
  __esModule: true,
  default: () => <div>trend-sidebar-content</div>,
}));
jest.mock('./../notes/NotesFeed', () => ({
  __esModule: true,
  default: ({ isStaff }: { isStaff: boolean }) => <div>notes-feed-content isStaff={String(isStaff)}</div>,
}));
jest.mock('./../admin/AdminCompanies', () => ({
  __esModule: true,
  default: () => <div>admin-companies-content</div>,
}));
jest.mock('./../admin/AdminUsers', () => ({
  __esModule: true,
  default: () => <div>admin-users-content</div>,
}));
jest.mock('./ArchiveTab', () => ({
  __esModule: true,
  default: () => <div>archive-tab-content</div>,
}));

const signOut = jest.fn();
const listCompanies = jest.fn();
const listActivePeriod = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signOut: (...args: unknown[]) => signOut(...args) },
    from: (table: string) => {
      if (table === 'billing_periods') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ single: (...args: unknown[]) => listActivePeriod(...args) }) }),
          }),
        };
      }
      return { select: () => ({ order: (...args: unknown[]) => listCompanies(...args) }) };
    },
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe('AppShell', () => {
  beforeEach(() => {
    signOut.mockReset();
    listCompanies.mockReset();
    listActivePeriod.mockReset().mockResolvedValue({ data: { id: 'period-1' } });
  });

  it('shows the AWS tab and the Uploaded Files tab for a client', async () => {
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    expect(await screen.findByText('report-tab-content for aws')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /uploaded files/i })).toBeInTheDocument();
  });

  it('switches to the Uploaded Files tab when clicked', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /uploaded files/i }));

    expect(await screen.findByText('files-tab-content')).toBeInTheDocument();
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

  it('shows the Azure tab and the Compare tab, and switches to each', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /azure/i }));
    expect(await screen.findByText('report-tab-content for azure')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    expect(await screen.findByText('compare-tab-content')).toBeInTheDocument();
  });

  it('shows the Notes & Follow-ups tab for a client, but not the Admin tab', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=false')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin tab for staff, with Notes marked isStaff=true', async () => {
    listCompanies.mockResolvedValueOnce({ data: [{ id: 'c1', name: 'Acme Corp', created_at: '2026-07-01T00:00:00.000Z' }] });
    const user = userEvent.setup();
    render(<AppShell userId="staff-1" role="staff" companyId={null} />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /notes/i }));
    expect(await screen.findByText('notes-feed-content isStaff=true')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /admin/i }));
    expect(await screen.findByText('admin-companies-content')).toBeInTheDocument();
    expect(screen.getByText('admin-users-content')).toBeInTheDocument();
  });

  it('shows the Archive tab and switches to it', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await screen.findByText('report-tab-content for aws');
    await user.click(screen.getByRole('tab', { name: /archive/i }));
    expect(await screen.findByText('archive-tab-content')).toBeInTheDocument();
  });
});
```

Every test's underlying behavior assertion is unchanged from before this stage — only the synchronous `getBy*` calls that targeted gated panel content became `await screen.findBy*` (or gained a preceding `await screen.findByText('report-tab-content for aws')` to let the initial period lookup resolve before interacting further), reflecting the new, real async gap this stage introduces. Nothing about what's being tested changed.

- [ ] **Step 18: Run the full test suite**

Run: `npm test` — all pass, including `AppShell.test.tsx`'s existing tab-switching/sign-out tests (unchanged behavior), `CostReportTab.test.tsx`/`CompareTab.test.tsx` from Part A, and the new Archive-tab test.

- [ ] **Step 19: Run the full pipeline**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build` — all pass. This is the first point in this task where the pipeline is expected to be fully green (Part A alone was not) — `tsc`/`build` failing here means something in Part A and Part B is still inconsistent, not that it's safe to defer further.

- [ ] **Step 20: Commit**

```bash
git add components/reports/CostReportTab.tsx components/reports/CostReportTab.test.tsx components/reports/CompareTab.tsx components/reports/CompareTab.test.tsx app/globals.css components/shell/ArchiveTab.tsx components/shell/ArchiveTab.module.css components/shell/ArchiveTab.test.tsx components/shell/AppShell.tsx components/shell/AppShell.test.tsx components/shell/AppShell.module.css
git commit -m "Scope CostReportTab/CompareTab to a period, add chart polish + drill-down + print; add Archive tab and wire periods/trend-sidebar into AppShell; remove Day/Week/Month"
```

---

## Task 11: Manual verification and deployment

**Files:** none (verification and deployment only).

- [ ] **Step 1: Manual end-to-end pass**

Using a disposable staff test account (create via Supabase's proper Admin API — never touch `auth.users`/credentials directly or reset an existing account's password; if no test account is available, stop and ask rather than improvising), sign in and:

1. Confirm a brand-new company (create one via Admin) starts with an empty active period and can immediately accept an upload.
2. Upload AWS and Azure billing files for an existing test company; confirm the AWS/Azure/Compare/Line Items tabs all show that period's data.
3. Confirm the Line Items tab: sorts by Date and Cost correctly, filters by provider and (via drill-down from a chart bar) by service, paginates correctly if the seeded data exceeds one page (or note if it doesn't and this can't be fully exercised — flag as a gap rather than skip silently).
4. Confirm the note/todo indicator appears on a line item after adding a note referencing its `cost_record_id` (this may require a direct SQL insert with a real `cost_record_id` for the test, since the UI doesn't yet have a "link this note to this record" affordance — that's expected, not a bug, per this stage's scope).
5. Confirm the 12-month trend sidebar shows correct totals, visible on AWS/Azure/Compare/Line Items, hidden on Uploaded Files/Notes/Archive/Admin.
6. Click "Archive this period" — confirm the archive dialog appears, confirms, and afterward: the Uploaded Files/Notes forms are gone from the (now-fresh) active period's view, and the Archive tab lists the just-archived period with a correct auto-computed date-range label.
7. Click into the archived period from the Archive tab — confirm every report tab (AWS/Azure/Compare/Line Items/Uploaded Files/Notes & Follow-ups) shows that period's frozen data, read-only (no upload form, no add-note/todo/time-entry inputs), with the "Viewing archived period" banner visible. Click "Back to current" — confirm it returns to the live active period.
8. Confirm the Print button (visible on AWS/Azure/Compare) triggers the browser print dialog and the printed preview hides the top bar/tab strip (`print-hidden` elements).
9. Switch companies (as staff) — confirm `viewingPeriodId` resets to the new company's active period, not whatever was selected for the previous company.

If anything fails, fix it and re-run the affected steps before deploying.

- [ ] **Step 2: Deploy**

Push to `main`, confirm the Vercel production build succeeds, and re-run the Step 1 pass (or as much of it as practical) against the production URL.

- [ ] **Step 3: Report**

Summarize what was verified, confirm the period lifecycle works end-to-end in production, and note that PDF export (deferred per the spec's Non-goals) is the recommended next stage.
