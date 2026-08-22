# Stage B — Review Periods, Archive, Trend Sidebar & Reporting Enhancements — Design Spec

## Overview

Stage A (Tailwind + shadcn UI foundation + dark mode) is live in production. The roadmap originally scoped Stage B as "enhanced charts + a line-item view," built around the existing Day/Week/Month granularity model — but the actual usage pattern for this product is different: a company uploads one month's AWS/Azure billing data, reviews it in full (charts, comparison, line items, notes/follow-ups, printing), and when the next month's data is ready, explicitly archives the current review and starts fresh. This stage replaces the granularity-slider model with a first-class **billing period** concept, and builds the enhanced reporting (better charts, a line-item view, a 12-month trend sidebar) on top of it.

This is a substantially bigger, more foundational change than the original Stage B sketch — it redefines how the app's core reporting data is organized, not just how it's displayed.

## Goals

- Introduce `billing_periods`: exactly one **active** period per company at a time, holding that company's current review cycle (uploads, cost records, notes, todos, time entries).
- Let staff or client users **archive** the current period (freezing it, read-only, forever) and start a new empty active period, via one atomic server-side action.
- Add an **Archive** tab listing past periods (auto-labeled from their data's date range); selecting one re-renders the full report experience (AWS/Azure/Compare/Line Items/Uploaded Files/Notes & Follow-ups) scoped to that period's frozen data, entirely read-only.
- Add a **Line Items** tab: a real, sortable, server-side-paginated table of individual `cost_records` rows for the period being viewed, with service/provider filtering and drill-down from the existing charts/comparison table.
- Add a **12-month trend sidebar** (AWS/Azure totals per month, trailing 12 months, spanning across period boundaries) visible on the report tabs (AWS/Azure/Compare/Line Items).
- Improve the existing AWS/Azure charts (grid/legend/currency tooltip) and give Compare its first chart (grouped AWS-vs-Azure bar per category).
- Add browser-print support (a print stylesheet + a Print button) for both the active period and any archived period.
- Migrate existing data: every company with existing `cost_records`/`uploaded_files`/`review_notes`/`review_todos`/`time_entries` gets one auto-created active period, and all their existing rows are backfilled to point at it — nothing already in the system disappears or needs re-entry.

## Non-goals (this stage)

- **PDF export** — the user wants both browser print and a dedicated, styled PDF export, but given how large this stage already is, PDF export is explicitly deferred to an immediate fast-follow stage (its own brainstorm/spec/plan cycle), built on top of an already-working, already-reviewed period model. This stage ships browser print only.
- No per-provider independent period timelines — one period always covers both AWS and Azure together for a company (confirmed).
- No custom arbitrary date-range picker — periods replace Day/Week/Month granularity entirely for the report tabs; no new calendar/range-picker UI.
- No automatic/calendar-triggered archiving — archiving is always an explicit user action ("as needed"), never automatic on month rollover.
- No changes to the Admin tab's company/user management beyond company creation also creating that company's initial active period.
- No changes to authentication, RLS helper functions (`private.is_staff()`/`private.user_company_id()`), or the existing staff/client role model.

## Technical constraints

- Must not regress any existing test. Existing tests for `CostReportTab`/`CompareTab`/`NotesFeed`/`UploadedFilesList` will need real, called-out updates (they currently query without period-scoping) — these are expected, reviewable changes, not silent workarounds.
- Every new table/view gets RLS via `private.is_staff()`/`private.user_company_id()` (wrapped in `(select ...)` for per-statement caching) **plus explicit base-table GRANTs in the same migration** — this project's hard-learned, non-negotiable rule (a prior gap here silently broke earlier phases).
- The "exactly one active period per company" invariant is enforced at the database level via a partial unique index (`unique (company_id) where status = 'active'`), not just application logic.
- All writes to period-scoped tables (`cost_records`, `uploaded_files`, `review_notes`, `review_todos`, `time_entries`) determine the target `period_id` **server-side**, by looking up the caller's company's current active period — never accept a `period_id` from the client.
- The archive action (flip active → archived, insert next active) must be atomic — implemented as a single service-role transaction behind an API route, not two separate client-side writes.
- PostgREST's ~1000-row page cap means the Line Items table needs true server-side pagination (`.range()` per page, a separate `count`-only query for total pages) — the existing "page through everything, then aggregate client-side" pattern used by `CostReportTab`/`CompareTab` is the wrong tool here and must not be reused for Line Items.
- The 12-month trend sidebar must not page through raw `cost_records` client-side to compute monthly sums — it reads from a dedicated server-side aggregate (a Postgres view), returning at most ~24 rows regardless of how much raw data exists.
- `@tanstack/react-table` is a new dependency (user-approved) driving a new hand-authored `components/ui/table.tsx` shadcn-style primitive — the shadcn CLI remains environmentally broken in this repo (documented in Stage A's ledger: npm 11 rejects a flag the CLI unconditionally passes), so this follows the same hand-authoring approach Stage A used for Button/Tabs/Card/Badge.
- Existing re-upload/correction logic (delete overlapping `cost_records` before inserting a re-upload's rows, from an earlier phase) must be scoped to `period_id` in addition to company/provider/date, so it can never delete rows belonging to an already-archived period. The upload route still needs to look up the company's active period id explicitly for this delete query's `WHERE` clause — the trigger (above) removes the need for the route to set `period_id` on its own inserts, but the route still needs to know the id for this one read.

## Architecture

### Data model

**New table `public.billing_periods`:**
- `id uuid primary key default gen_random_uuid()`
- `company_id uuid not null references public.companies(id) on delete cascade`
- `status text not null default 'active' check (status in ('active', 'archived'))`
- `created_at timestamptz not null default now()`
- `archived_at timestamptz` (nullable; set when archived)
- Partial unique index: `create unique index billing_periods_one_active_idx on public.billing_periods (company_id) where status = 'active';`
- No stored label. A period's display label is always computed on read from `min(usage_date)`/`max(usage_date)` of its linked `cost_records` (e.g. "Aug 2026"), falling back to "Current period (no data yet)" when empty — this can never go stale and needs no extra write path.

**Existing tables gain `period_id uuid not null references public.billing_periods(id)`:** `cost_records`, `uploaded_files`, `review_notes`, `review_todos`, `time_entries`. All five are stamped the same uniform way: a `security definer` Postgres trigger function (`private.stamp_active_period()`), applied `before insert` on all five tables, looks up `new.company_id`'s active period and fills `new.period_id` itself (raising a clear exception if no active period exists — which should never happen given the archive action's atomicity below). Postgres runs `before insert` triggers before NOT NULL is checked, so this is what makes it safe to apply the `not null` constraint in the same migration as the trigger, regardless of whether any application code has been updated yet — every insert gets a correct `period_id` unconditionally, without any app code needing to know `period_id` exists at all. (An earlier version of this design had the upload route set `period_id` explicitly on `cost_records`/`uploaded_files` inserts instead of using the trigger there too — rejected once it became clear that would make the schema migration itself a breaking change for the *live* app's uploads until the corresponding route code also shipped. The uniform trigger removes that ordering hazard entirely.)

**RLS on `billing_periods`:** read-only for `authenticated` (staff: any company; client: own company via `private.user_company_id()`). No `authenticated` INSERT/UPDATE/DELETE grants — all writes happen via `service_role` only, from the archive API route.

**New view `public.monthly_cost_by_provider`:** `company_id, month (date_trunc('month', usage_date)), cloud_provider, total (sum(cost))`, grouped over `cost_records`, filtered to the trailing 12 months. RLS mirrors `cost_records`'s existing access policy (staff: any; client: own company) — implemented as a `security_invoker` view so it inherits the base table's RLS rather than needing its own duplicate policy set.

### Period lifecycle & the archive action

`POST /api/periods/archive` (Node runtime, following the existing admin-route pattern): body `{ companyId }`. Authorization via `requireCompanyAccess(companyId)` from `lib/admin-guard.ts` (already correctly allows staff-any-company or client-own-company — no new guard needed). Using the service-role client, in one transaction: update the current active period to `status = 'archived', archived_at = now()`, then insert a new `status = 'active'` period for that company. Returns the new active period's id.

Company creation (`AdminCompanies.tsx`) is currently a direct client-side insert into `public.companies` (RLS-permitted for staff), not a server route — so a new company's first active period is provisioned the same way `profiles` rows already are for new auth users in this codebase: a `security definer` trigger function (`private.handle_new_company()`), `after insert on public.companies`, that inserts one `status = 'active'` `billing_periods` row for the new company. No change needed to `AdminCompanies.tsx` itself.

### Tabs & navigation

`AppShell`'s tab list becomes: AWS | Azure | Compare | Line Items | Uploaded Files | Notes & Follow-ups | **Archive** | Admin (staff-only). A new `activePeriodId`/`viewingPeriodId` distinction is added to `AppShell`'s state: `viewingPeriodId` defaults to the company's current active period, and switching to the Archive tab and selecting a past period sets `viewingPeriodId` to that period's id instead — every report tab receives `viewingPeriodId` as a prop and scopes its queries to it. A "Back to current" control (and a visible "Viewing archived period: <label>" banner) clears `viewingPeriodId` back to the active period. Switching companies (staff only, via the existing company switcher) always resets `viewingPeriodId` back to the newly-selected company's active period.

While `viewingPeriodId` is not the active period, every write affordance is hidden: `UploadForm` is not rendered in Uploaded Files, and `NotesFeed`'s add-note/add-todo/log-time inputs are not rendered — those tabs render read-only lists only.

An "Archive this period" button appears in the top bar, visible only while viewing the active period, gated behind a confirmation dialog (matching the existing user-delete confirm-dialog pattern from Phase 3) before calling the archive API.

### Line Items tab

New `components/reports/LineItemsTab.tsx` + `lib/lineItemQuery.ts` (paginated query + count helper, pure/testable). Built on a new hand-authored `components/ui/table.tsx` (shadcn "Table" template: `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`) driving `@tanstack/react-table`'s headless sort/pagination state — the actual data fetch stays a plain paginated Supabase query (`.eq('period_id', viewingPeriodId)`, `.order()`, `.range()`, plus a separate `{ count: 'exact', head: true }` query for total pages), keeping server-side pagination honest rather than letting the table library encourage "fetch everything" habits.

Columns: Date, Provider, Service, Account (nullable), Cost, and a small indicator if any `review_note`/`review_todo` already references that row (via the existing nullable `cost_record_id` FK — no schema change needed for this). Sort: server-side, on Date or Cost. Filter: service (multi-select) and provider — both applied server-side via `.in()`/`.eq()`.

Drill-down: clicking a bar in AWS/Azure's by-service chart, or a row in Compare's category table, navigates to the Line Items tab with its service filter (or, for a category, every service `categorizeService` maps to that category) pre-set.

### Chart & print polish

`CostReportTab`'s existing Line/Bar charts gain `<CartesianGrid>`, `<Legend>`, and a currency-formatted `<Tooltip>` (additive, no data-shape change). `CompareTab` gets its first chart: a grouped AWS-vs-Azure bar chart per category, reusing the already-computed `aggregateByCategoryComparison` output.

A `@media print` stylesheet (in `globals.css` or a dedicated print stylesheet) hides navigation/tabs/buttons/inputs and lays out charts/tables cleanly for paper; a "Print" button (visible on every report tab) calls `window.print()`. Works identically whether viewing the active period or an archived one.

### Migration & backfill

One migration, applied and tested as a single unit (this is what makes it safe regardless of app-code deploy timing): create `billing_periods` (with RLS + grants) and the `private.stamp_active_period()` trigger function + its `before insert` triggers on all 5 tables; insert one active `billing_periods` row for every existing company (`select id, 'active' from public.companies`, not just companies with existing data — a company with zero uploads so far still needs an active period to write into later); add `period_id` to the 5 existing tables as nullable; backfill (`update ... set period_id = (select id from billing_periods where company_id = ... and status = 'active')` for each table); alter `period_id` to `not null` on all 5. Add `private.handle_new_company()` (trigger on `companies`, `after insert`, creates that company's first active period) in the same migration.

### 12-month trend sidebar

New `components/reports/TrendSidebar.tsx`, rendered inside the report tabs' shared layout (AWS/Azure/Compare/Line Items only, per approved design). Queries `monthly_cost_by_provider` directly (no pagination needed — at most 24 rows). Small Recharts line/bar per provider, plus a compact numeric list, matching the existing chart-styling conventions from Stage A (theme-aware `var(--primary)` etc.). The trailing-12-months window is always anchored to the real current date (`now()`), never to whichever period is being viewed — it's a fixed, always-current trend reference, so it looks identical whether you're viewing the active period or browsing an archived one from months ago.

## Testing

- Every existing report-tab test (`CostReportTab.test.tsx`, `CompareTab.test.tsx`, `NotesFeed.test.tsx`, `UploadedFilesList.test.tsx`) needs updating to account for period-scoping — called out explicitly per task, not silently patched.
- New: `lib/lineItemQuery.test.ts` (pure pagination/count logic), `LineItemsTab.test.tsx`, `TrendSidebar.test.tsx`, an `AppShell.test.tsx` addition covering the Archive tab / `viewingPeriodId` switch and the archive-button confirm flow.
- Migration correctness: verify via Supabase MCP (`execute_sql`) against a snapshot of pre-migration data that backfilled `period_id` values are correct and no row is left with a null `period_id` before the `not null` constraint is applied.
- Manual verification (chrome-devtools, matching every phase's convention): full period lifecycle end-to-end — upload data into a fresh company's initial active period, review it across all report tabs, archive it, confirm the Archive tab shows it correctly and read-only, confirm a brand-new active period is ready for the next upload, confirm the trend sidebar's totals are correct and span both the archived and new active period's data.

## Future work (explicitly out of scope now)

- **PDF export** — an immediate fast-follow stage once this ships; its own brainstorm/spec/plan cycle.
- Per-company/per-service threshold overrides, anomaly detection, and AI narrative layers remain Stage D's concern (unchanged from the original roadmap).
- Stripe billing remains Stage C's concern (unchanged from the original roadmap) — worth noting `billing_periods` (this stage's review-cycle concept) and Stage C's future `subscriptions` table (payment/access-gating concept) are unrelated despite the similar naming; no shared code or schema between them.
