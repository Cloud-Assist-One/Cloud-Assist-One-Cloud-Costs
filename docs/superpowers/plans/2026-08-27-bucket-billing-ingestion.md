# Bucket Billing Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point a company at an S3 bucket or Azure Blob container and have the portal discover its cost exports, ingest up to twelve months of them into a period per month, and show a per-run report.

**Architecture:** All the layout knowledge (CUR manifests, multi-part runs, Azure's cumulative daily snapshots) lives in one pure function, `discoverRuns`, that takes a flat object listing and returns runs — so it is fully testable with no cloud account. Downloading is behind a two-method `ObjectStore` interface so the pull route never branches on provider. The ~100 lines of ingestion currently inline in the upload route are extracted to `lib/ingestCostFile.ts` and shared by both paths.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Supabase, AWS SDK v3 (`@aws-sdk/client-s3`), `@azure/storage-blob` (new), `@azure/identity`, Node `zlib`, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-bucket-billing-ingestion-design.md`

## Global Constraints

- **Every commit message ends with a blank line then the trailer** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Git commands must be scoped to explicit paths.** Always `git add <path>` — never `git add .`, never `git add -A`.
- **Exactly one new dependency: `@azure/storage-blob`.** Gzip uses Node's built-in `zlib` — do not add a gzip package.
- **Code style:** ES modules, `async`/`await` (never `.then()` chains), 2-space indentation, descriptive names. Comment *why*, not *what*.
- **Caps, all reported and never silent:** 12 runs per pull, 200 parts per run, 500 MB decompressed per pull. Anything a cap excludes appears in the report as `skipped` with a reason naming the cap.
- **Nothing is dropped silently.** Every discovered run ends as `imported`, `skipped` with a reason, or `failed` with a reason.
- **An empty active period is never archived** — there is nothing to preserve and it would leave a blank period in the Archive tab.
- **The Quick Pull route path does not change.** `/api/{provider}/pull-billing` keeps its URL; only its labels change.
- **Pure modules take no SDK types.** `discoverRuns`, `deriveBillingMonth` and `gunzipIfNeeded` must not import from `@aws-sdk/*` or `@azure/*`.
- **Test commands:** `npx jest <path>` for one suite, `npm test` for all. Type check `npx tsc --noEmit`. Lint `npm run lint`. Build `npm run build`.
- **This is not the Next.js in your training data** (16.3.1, breaking changes). Before writing route-handler code read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. If `AGENTS.md` appears modified in your tree, commit it with your work rather than reverting it.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260830000000_billing_file_sources.sql` | New table, `uploaded_files` columns, two unique indexes, duplicate pre-flight |
| `lib/types.ts` (modify) | `BillingFileSource`, `RemoteObject`, `ExportRun`, `CurManifest`, `BillingSourcePullResult` |
| `lib/gunzipIfNeeded.ts` | Decompress a `.gz` buffer. Pure |
| `lib/deriveBillingMonth.ts` | Month from parsed rows. Pure |
| `lib/exportDiscovery.ts` | Object listing → `ExportRun[]`. Where all CUR/Azure layout knowledge lives. Pure, with an injected manifest reader |
| `lib/ingestCostFile.ts` | Parse buffers → replace date range → insert 22 columns → mark the file row. Extracted from the upload route, shared by both paths |
| `lib/periodForMonth.ts` | Get-or-create the period a month belongs in |
| `lib/objectStore.ts` | The `ObjectStore` interface |
| `lib/objectStoreS3.ts` / `lib/objectStoreAzureBlob.ts` | The two implementations |
| `app/api/upload/route.ts` (modify) | Calls `ingestCostFile`; its existing tests must pass unchanged |
| `app/api/settings/billing-file-sources/route.ts` | GET / POST / DELETE sources |
| `app/api/billing-sources/[sourceId]/pull/route.ts` | The pull orchestration |
| `components/settings/BillingFileSourcesPanel.tsx` | Configure sources, in Settings |
| `components/reports/PullBillingFromBucketModal.tsx` | Confirmation + per-run report |
| `components/reports/CostReportTab.tsx` (modify) | Two buttons: Quick Pull, Pull Billing |

**Task order builds bottom-up.** Tasks 2–4 are pure functions with no dependencies; 5–8 are the data and I/O layers; 9–10 the routes; 11–12 the UI. Nothing depends on a task after it.

---

### Task 1: Migration, types and dependency

**Files:**
- Create: `supabase/migrations/20260830000000_billing_file_sources.sql`
- Modify: `lib/types.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: the `billing_file_sources` table; `uploaded_files.source_id`, `.source_object_key`, `.source_object_etag`; types `BillingFileSource`, `RemoteObject`, `CurManifest`, `ExportRun`, `BillingSourcePullResult`

- [ ] **Step 1: Install the dependency**

```bash
npm install @azure/storage-blob
```

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260830000000_billing_file_sources.sql`:

```sql
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
```

- [ ] **Step 3: Add the types**

Append to `lib/types.ts`:

```ts
export interface BillingFileSource {
  id: string;
  company_id: string;
  credential_id: string;
  cloud_provider: CloudProvider;
  /** S3 bucket name, or Azure "account/container". */
  container: string;
  prefix: string;
  label: string;
  enabled: boolean;
  schedule_enabled: boolean;
  last_pulled_at: string | null;
  created_at: string;
}

/** One object in a bucket listing, provider-agnostic. */
export interface RemoteObject {
  key: string;
  etag: string;
  size: number;
  lastModified: string | null;
}

/** The parts of an AWS Cost and Usage Report Manifest.json this code reads. */
export interface CurManifest {
  assemblyId: string;
  reportKeys: string[];
  /** Timestamps like "20260801T000000.000Z". */
  billingPeriod: { start: string; end: string };
}

/** One import unit: a CUR run's parts, or a single Azure snapshot. */
export interface ExportRun {
  /** Identifies the run for dedupe: the manifest key, or the snapshot's own key. */
  key: string;
  etag: string;
  /** Every object to download and parse, in order. */
  parts: string[];
  /** First day of the month when the layout states it; null means derive from contents. */
  month: string | null;
  totalBytes: number;
}

export interface BillingSourcePullRun {
  key: string;
  month: string | null;
  status: 'imported' | 'skipped' | 'failed';
  periodKind?: 'active' | 'archived';
  reason?: string;
  rowCount?: number;
}

export interface BillingSourcePullResult {
  runs: BillingSourcePullRun[];
  imported: number;
  skipped: number;
  failed: number;
}
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/types.ts supabase/migrations/20260830000000_billing_file_sources.sql
git commit -m "Add billing file source schema and types"
```

---

### Task 2: Gzip decompression

**Files:**
- Create: `lib/gunzipIfNeeded.ts`
- Test: `lib/gunzipIfNeeded.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `gunzipIfNeeded(key: string, buffer: Buffer): Buffer`

- [ ] **Step 1: Write the failing test**

Create `lib/gunzipIfNeeded.test.ts`:

```ts
import { gzipSync } from 'node:zlib';
import { gunzipIfNeeded } from './gunzipIfNeeded';

describe('gunzipIfNeeded', () => {
  it('decompresses a .gz key', () => {
    const original = Buffer.from('service,cost\nEC2,10\n');

    const result = gunzipIfNeeded('report-00001.csv.gz', gzipSync(original));

    expect(result.toString()).toBe(original.toString());
  });

  it('matches the extension case-insensitively', () => {
    const original = Buffer.from('a,b\n1,2\n');

    expect(gunzipIfNeeded('REPORT.CSV.GZ', gzipSync(original)).toString()).toBe(original.toString());
  });

  it('returns a plain .csv untouched', () => {
    const plain = Buffer.from('service,cost\nEC2,10\n');

    expect(gunzipIfNeeded('report.csv', plain)).toBe(plain);
  });

  // An .xlsx is a zip container, and gunzipping it would corrupt it.
  it('returns an .xlsx untouched', () => {
    const plain = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

    expect(gunzipIfNeeded('export.xlsx', plain)).toBe(plain);
  });

  // A key can lie. Failing with the key named beats handing the parser
  // gzip bytes and getting an unintelligible parse error instead.
  it('throws a message naming the key when the bytes are not gzip', () => {
    expect(() => gunzipIfNeeded('broken.csv.gz', Buffer.from('not gzip at all'))).toThrow(/broken\.csv\.gz/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/gunzipIfNeeded.test.ts`
Expected: FAIL — `Cannot find module './gunzipIfNeeded'`

- [ ] **Step 3: Write the implementation**

Create `lib/gunzipIfNeeded.ts`:

```ts
import { gunzipSync } from 'node:zlib';

/**
 * Cost and Usage Report parts arrive gzipped far more often than not, and the
 * spreadsheet parser cannot see through that. Node's zlib handles it, so no
 * dependency is needed.
 */
export function gunzipIfNeeded(key: string, buffer: Buffer): Buffer {
  if (!key.toLowerCase().endsWith('.gz')) return buffer;

  try {
    return gunzipSync(buffer);
  } catch (err) {
    // Naming the key here is the difference between a fixable report and the
    // parser later failing on binary garbage for no stated reason.
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new Error(`Could not decompress ${key}: ${message}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/gunzipIfNeeded.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/gunzipIfNeeded.ts lib/gunzipIfNeeded.test.ts
git commit -m "Add gzip decompression for CUR report parts"
```

---

### Task 3: Derive the billing month from parsed rows

**Files:**
- Create: `lib/deriveBillingMonth.ts`
- Test: `lib/deriveBillingMonth.test.ts`

**Interfaces:**
- Consumes: `ParsedCostRow` from `@/lib/parseCostFile`
- Produces: `deriveBillingMonth(rows: readonly { usage_date: string }[]): string | null` — the first day of the month, `YYYY-MM-01`, or null

- [ ] **Step 1: Write the failing test**

Create `lib/deriveBillingMonth.test.ts`:

```ts
import { deriveBillingMonth } from './deriveBillingMonth';

function rows(...dates: string[]) {
  return dates.map((usage_date) => ({ usage_date }));
}

describe('deriveBillingMonth', () => {
  it('returns the first day of the month the rows belong to', () => {
    expect(deriveBillingMonth(rows('2026-08-01', '2026-08-15', '2026-08-31'))).toBe('2026-08-01');
  });

  // A CUR often carries a few days either side of the boundary. The month
  // holding most of the usage is the month the file is for.
  it('picks the month holding the most rows when a file straddles a boundary', () => {
    expect(deriveBillingMonth(rows('2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03'))).toBe('2026-08-01');
  });

  // Deterministic beats arbitrary: an exact tie always resolves the same way,
  // so a re-pull of the same file cannot land in a different period.
  it('breaks an exact tie toward the earlier month', () => {
    expect(deriveBillingMonth(rows('2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'))).toBe('2026-07-01');
  });

  it('returns null for an empty parse', () => {
    expect(deriveBillingMonth([])).toBeNull();
  });

  it('ignores rows whose date is unusable rather than failing the whole file', () => {
    expect(deriveBillingMonth(rows('not-a-date', '2026-08-10', '2026-08-11'))).toBe('2026-08-01');
  });

  it('returns null when no row has a usable date', () => {
    expect(deriveBillingMonth(rows('not-a-date', ''))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/deriveBillingMonth.test.ts`
Expected: FAIL — `Cannot find module './deriveBillingMonth'`

- [ ] **Step 3: Write the implementation**

Create `lib/deriveBillingMonth.ts`:

```ts
/**
 * The billing month a parsed file is for, taken from its contents.
 *
 * Used as the fallback when a bucket layout does not state the month, and as
 * a cross-check when it does — a manifest claiming August over rows that are
 * plainly July should fail the run rather than import into the wrong period.
 */
export function deriveBillingMonth(rows: readonly { usage_date: string }[]): string | null {
  const countByMonth = new Map<string, number>();

  for (const row of rows) {
    const match = /^(\d{4})-(\d{2})-\d{2}/.exec(row.usage_date ?? '');
    if (!match) continue;
    const month = `${match[1]}-${match[2]}-01`;
    countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
  }

  if (countByMonth.size === 0) return null;

  // Sorted so an exact tie resolves toward the earlier month every time: a
  // re-pull of the same file must never land in a different period.
  return [...countByMonth.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/deriveBillingMonth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/deriveBillingMonth.ts lib/deriveBillingMonth.test.ts
git commit -m "Add billing month derivation from parsed rows"
```

---

### Task 4: Export discovery

**Files:**
- Create: `lib/exportDiscovery.ts`
- Test: `lib/exportDiscovery.test.ts`

**Interfaces:**
- Consumes: `RemoteObject`, `CurManifest`, `ExportRun`, `CloudProvider` from `@/lib/types`
- Produces: `discoverRuns(provider: CloudProvider, objects: readonly RemoteObject[], readManifest: (key: string) => Promise<CurManifest | null>): Promise<ExportRun[]>`; helper `monthFromCompactDate(value: string): string | null`

**This is the task that decides whether the feature works on real buckets.** All the layout knowledge lives here, and it is a pure function of the listing — the manifest reader is injected, so every case below is tested with no cloud account.

- [ ] **Step 1: Write the failing test**

Create `lib/exportDiscovery.test.ts`:

```ts
import { discoverRuns, monthFromCompactDate } from './exportDiscovery';
import type { CurManifest, RemoteObject } from './types';

function obj(key: string, overrides: Partial<RemoteObject> = {}): RemoteObject {
  return { key, etag: `etag-${key}`, size: 1000, lastModified: '2026-08-05T00:00:00.000Z', ...overrides };
}

function manifestReader(manifests: Record<string, CurManifest>) {
  return async (key: string) => manifests[key] ?? null;
}

const noManifests = manifestReader({});

describe('monthFromCompactDate', () => {
  it('reads a CUR billing period start', () => {
    expect(monthFromCompactDate('20260801T000000.000Z')).toBe('2026-08-01');
  });

  it('reads a bare compact date from an Azure folder', () => {
    expect(monthFromCompactDate('20260801')).toBe('2026-08-01');
  });

  it('returns null for anything else', () => {
    expect(monthFromCompactDate('August 2026')).toBeNull();
    expect(monthFromCompactDate('')).toBeNull();
  });
});

describe('discoverRuns for AWS', () => {
  const manifest: CurManifest = {
    assemblyId: 'aaa',
    reportKeys: ['cur/report/20260801-20260901/aaa/report-00001.csv.gz', 'cur/report/20260801-20260901/aaa/report-00002.csv.gz'],
    billingPeriod: { start: '20260801T000000.000Z', end: '20260901T000000.000Z' },
  };

  it('emits one run per manifest, carrying every part', async () => {
    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/aaa/Manifest.json'),
        obj('cur/report/20260801-20260901/aaa/report-00001.csv.gz'),
        obj('cur/report/20260801-20260901/aaa/report-00002.csv.gz'),
      ],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('cur/report/20260801-20260901/aaa/Manifest.json');
    expect(runs[0].parts).toEqual(manifest.reportKeys);
    expect(runs[0].month).toBe('2026-08-01');
  });

  // CUR rewrites the whole month under a new assembly id on each refresh.
  // Importing both would double the month.
  it('keeps only the newest assembly when a month has several', async () => {
    const older: CurManifest = { ...manifest, assemblyId: 'old', reportKeys: ['cur/report/20260801-20260901/old/report-00001.csv.gz'] };

    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/old/Manifest.json', { lastModified: '2026-08-02T00:00:00.000Z' }),
        obj('cur/report/20260801-20260901/aaa/Manifest.json', { lastModified: '2026-08-09T00:00:00.000Z' }),
      ],
      manifestReader({
        'cur/report/20260801-20260901/old/Manifest.json': older,
        'cur/report/20260801-20260901/aaa/Manifest.json': manifest,
      })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toContain('/aaa/');
  });

  it('emits a run per month when the bucket holds several', async () => {
    const july: CurManifest = {
      assemblyId: 'jjj',
      reportKeys: ['cur/report/20260701-20260801/jjj/report-00001.csv.gz'],
      billingPeriod: { start: '20260701T000000.000Z', end: '20260801T000000.000Z' },
    };

    const runs = await discoverRuns(
      'aws',
      [obj('cur/report/20260801-20260901/aaa/Manifest.json'), obj('cur/report/20260701-20260801/jjj/Manifest.json')],
      manifestReader({
        'cur/report/20260801-20260901/aaa/Manifest.json': manifest,
        'cur/report/20260701-20260801/jjj/Manifest.json': july,
      })
    );

    expect(runs.map((run) => run.month).sort()).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('sums the parts it can size, so a caller can enforce a byte cap', async () => {
    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/aaa/Manifest.json', { size: 500 }),
        obj('cur/report/20260801-20260901/aaa/report-00001.csv.gz', { size: 4000 }),
        obj('cur/report/20260801-20260901/aaa/report-00002.csv.gz', { size: 6000 }),
      ],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs[0].totalBytes).toBe(10000);
  });

  // An unreadable manifest must not take the other months down with it.
  it('skips a manifest it cannot read and keeps the rest', async () => {
    const runs = await discoverRuns(
      'aws',
      [obj('cur/report/20260801-20260901/aaa/Manifest.json'), obj('cur/report/20260701-20260801/bad/Manifest.json')],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].month).toBe('2026-08-01');
  });
});

describe('discoverRuns for Azure', () => {
  // A scheduled daily export writes a full month-to-date snapshot each day.
  // Importing all of them would import August thirty-one times.
  it('keeps only the newest snapshot in a date-range folder', async () => {
    const runs = await discoverRuns(
      'azure',
      [
        obj('exports/daily/20260801-20260831/cost_1.csv', { lastModified: '2026-08-04T00:00:00.000Z' }),
        obj('exports/daily/20260801-20260831/cost_2.csv', { lastModified: '2026-08-05T00:00:00.000Z' }),
      ],
      noManifests
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('exports/daily/20260801-20260831/cost_2.csv');
    expect(runs[0].parts).toEqual(['exports/daily/20260801-20260831/cost_2.csv']);
    expect(runs[0].month).toBe('2026-08-01');
  });

  it('emits one run per date-range folder', async () => {
    const runs = await discoverRuns(
      'azure',
      [
        obj('exports/daily/20260801-20260831/cost.csv'),
        obj('exports/daily/20260701-20260731/cost.csv'),
      ],
      noManifests
    );

    expect(runs.map((run) => run.month).sort()).toEqual(['2026-07-01', '2026-08-01']);
  });
});

describe('discoverRuns fallback for hand-dropped files', () => {
  it('treats each spreadsheet as its own run with no stated month', async () => {
    const runs = await discoverRuns(
      'aws',
      [obj('august.csv'), obj('july.xlsx')],
      noManifests
    );

    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.month === null)).toBe(true);
    expect(runs.map((run) => run.parts.length)).toEqual([1, 1]);
  });

  it('ignores objects that are not spreadsheets', async () => {
    const runs = await discoverRuns('aws', [obj('notes.txt'), obj('logo.png'), obj('data.csv')], noManifests);

    expect(runs.map((run) => run.key)).toEqual(['data.csv']);
  });

  it('accepts a gzipped csv', async () => {
    const runs = await discoverRuns('aws', [obj('data.csv.gz')], noManifests);

    expect(runs).toHaveLength(1);
  });

  it('returns nothing for an empty bucket', async () => {
    expect(await discoverRuns('aws', [], noManifests)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/exportDiscovery.test.ts`
Expected: FAIL — `Cannot find module './exportDiscovery'`

- [ ] **Step 3: Write the implementation**

Create `lib/exportDiscovery.ts`:

```ts
import type { CloudProvider, CurManifest, ExportRun, RemoteObject } from './types';

const SPREADSHEET_PATTERN = /\.(csv|xlsx|xls)(\.gz)?$/i;
const MANIFEST_PATTERN = /manifest\.json$/i;
// The YYYYMMDD-YYYYMMDD folder both providers put a billing period in.
const DATE_RANGE_SEGMENT = /(?:^|\/)(\d{8})-(\d{8})(?:\/|$)/;

/** "20260801T000000.000Z" or "20260801" -> "2026-08-01". */
export function monthFromCompactDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})\d{2}/.exec(value ?? '');
  return match ? `${match[1]}-${match[2]}-01` : null;
}

function newest(a: RemoteObject, b: RemoteObject): RemoteObject {
  return (b.lastModified ?? '') > (a.lastModified ?? '') ? b : a;
}

/**
 * A bucket listing becomes a list of import units.
 *
 * The manifest reader is injected rather than called directly so that every
 * layout below is testable against a fixture listing, with no cloud account
 * and no network.
 */
export async function discoverRuns(
  provider: CloudProvider,
  objects: readonly RemoteObject[],
  readManifest: (key: string) => Promise<CurManifest | null>
): Promise<ExportRun[]> {
  const sizeByKey = new Map(objects.map((object) => [object.key, object.size]));

  // --- AWS: manifests are authoritative, and name every part of their run ---
  const manifestObjects = provider === 'aws' ? objects.filter((object) => MANIFEST_PATTERN.test(object.key)) : [];

  if (manifestObjects.length > 0) {
    // Newest assembly per month: CUR rewrites the whole month under a new
    // assembly id on each refresh, so importing every one would multiply it.
    const bestByMonth = new Map<string, { object: RemoteObject; manifest: CurManifest }>();

    for (const object of manifestObjects) {
      // One unreadable manifest must not take the other months down with it.
      const manifest = await readManifest(object.key).catch(() => null);
      if (!manifest) continue;

      const month = monthFromCompactDate(manifest.billingPeriod?.start ?? '');
      if (!month) continue;

      const existing = bestByMonth.get(month);
      if (!existing || newest(existing.object, object) === object) {
        bestByMonth.set(month, { object, manifest });
      }
    }

    if (bestByMonth.size > 0) {
      return [...bestByMonth.entries()].map(([month, { object, manifest }]) => ({
        key: object.key,
        etag: object.etag,
        parts: manifest.reportKeys,
        month,
        totalBytes: manifest.reportKeys.reduce((total, key) => total + (sizeByKey.get(key) ?? 0), 0),
      }));
    }
  }

  // --- Date-range folders: Azure's daily exports, and CUR without manifests ---
  const bestByFolder = new Map<string, { object: RemoteObject; month: string }>();

  for (const object of objects) {
    if (!SPREADSHEET_PATTERN.test(object.key)) continue;
    const match = DATE_RANGE_SEGMENT.exec(object.key);
    if (!match) continue;

    const month = monthFromCompactDate(match[1]);
    if (!month) continue;

    // Each daily export is a full month-to-date snapshot, so the newest one
    // is the complete one and the earlier ones are strict subsets of it.
    const existing = bestByFolder.get(month);
    if (!existing || newest(existing.object, object) === object) {
      bestByFolder.set(month, { object, month });
    }
  }

  if (bestByFolder.size > 0) {
    return [...bestByFolder.values()].map(({ object, month }) => ({
      key: object.key,
      etag: object.etag,
      parts: [object.key],
      month,
      totalBytes: object.size,
    }));
  }

  // --- Fallback: files someone dropped in by hand, month read from contents ---
  return objects
    .filter((object) => SPREADSHEET_PATTERN.test(object.key))
    .map((object) => ({
      key: object.key,
      etag: object.etag,
      parts: [object.key],
      month: null,
      totalBytes: object.size,
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/exportDiscovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/exportDiscovery.ts lib/exportDiscovery.test.ts
git commit -m "Add export discovery for CUR manifests and Azure snapshots"
```

---

### Task 5: Extract the ingestion from the upload route

**Files:**
- Create: `lib/ingestCostFile.ts`
- Test: `lib/ingestCostFile.test.ts`
- Modify: `app/api/upload/route.ts:86-186` (the whole `try` block)

**Interfaces:**
- Consumes: `parseCostFile` from `@/lib/parseCostFile`; `CloudProvider` from `@/lib/types`
- Produces:
  ```ts
  export interface IngestCostFileInput {
    adminClient: SupabaseClient;
    companyId: string;
    cloudProvider: CloudProvider;
    periodId: string;
    uploadedFileId: string;
    /** One per part: a CUR run has many, an upload has one. Parsed and concatenated. */
    buffers: readonly Buffer[];
  }
  export interface IngestCostFileResult {
    status: 'processed' | 'error';
    rowCount?: number;
    errors?: string[];
  }
  export async function ingestCostFile(input: IngestCostFileInput): Promise<IngestCostFileResult>
  ```

**The point of this task is that there is one implementation, not two.** The upload route carries ~100 lines of this inline; the pull route needs exactly the same behaviour including the 22-column insert list. **`app/api/upload/route.ts`'s existing tests must pass unchanged** — that is what proves the extraction was behaviour-preserving. Do not modify them.

- [ ] **Step 1: Write the failing test**

Create `lib/ingestCostFile.test.ts`:

```ts
import { ingestCostFile } from './ingestCostFile';
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('./parseCostFile', () => ({ parseCostFile: jest.fn() }));
import { parseCostFile } from './parseCostFile';

function row(overrides: Record<string, unknown> = {}) {
  return {
    service_name: 'Amazon EC2',
    usage_date: '2026-08-10',
    cost: 12.5,
    account_id: '123456789012',
    resource_id: 'i-abc',
    resource_group: null,
    region: 'us-east-1',
    availability_zone: null,
    instance_type: 't3.micro',
    database_engine: null,
    meter_category: null,
    meter_name: null,
    usage_type: null,
    operation: null,
    subscription_id: null,
    subscription_name: null,
    purchase_type: null,
    reservation_id: null,
    reservation_name: null,
    quantity: 1,
    unit: 'Hrs',
    unit_price: 12.5,
    effective_price: 12.5,
    currency: 'USD',
    charge_type: 'Usage',
    tags: null,
    ...overrides,
  };
}

function makeClient() {
  const deleteChain = { eq: jest.fn(), gte: jest.fn(), lte: jest.fn() };
  deleteChain.eq.mockReturnValue(deleteChain);
  deleteChain.gte.mockReturnValue(deleteChain);
  deleteChain.lte.mockResolvedValue({ error: null });

  const insert = jest.fn().mockResolvedValue({ error: null });
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn().mockReturnValue({ eq: updateEq });

  const client = {
    from: jest.fn((table: string) => {
      if (table === 'cost_records') return { delete: () => deleteChain, insert };
      return { update };
    }),
  };

  return { client: client as unknown as SupabaseClient, deleteChain, insert, update, updateEq };
}

function input(over: Record<string, unknown> = {}) {
  return {
    adminClient: makeClient().client,
    companyId: 'company-1',
    cloudProvider: 'aws' as const,
    periodId: 'period-1',
    uploadedFileId: 'file-1',
    buffers: [Buffer.from('x')],
    ...over,
  };
}

describe('ingestCostFile', () => {
  beforeEach(() => {
    (parseCostFile as jest.Mock).mockReset();
  });

  it('inserts every parsed row and reports the count', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row(), row()], errors: [] });
    const { client, insert } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result).toEqual({ status: 'processed', rowCount: 2 });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
  });

  // Multi-part CUR: the parts are one logical file and must land as one set.
  it('parses every buffer and concatenates the rows', async () => {
    (parseCostFile as jest.Mock)
      .mockReturnValueOnce({ rows: [row()], errors: [] })
      .mockReturnValueOnce({ rows: [row(), row()], errors: [] });
    const { client, insert } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client, buffers: [Buffer.from('a'), Buffer.from('b')] }));

    expect(parseCostFile).toHaveBeenCalledTimes(2);
    expect(result.rowCount).toBe(3);
    expect(insert.mock.calls[0][0]).toHaveLength(3);
  });

  // A corrected export replacing an earlier one must not double the month.
  it('deletes the date range it is about to insert, scoped to this period', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({
      rows: [row({ usage_date: '2026-08-05' }), row({ usage_date: '2026-08-20' })],
      errors: [],
    });
    const { client, deleteChain } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(deleteChain.eq).toHaveBeenCalledWith('company_id', 'company-1');
    expect(deleteChain.eq).toHaveBeenCalledWith('cloud_provider', 'aws');
    expect(deleteChain.eq).toHaveBeenCalledWith('period_id', 'period-1');
    expect(deleteChain.gte).toHaveBeenCalledWith('usage_date', '2026-08-05');
    expect(deleteChain.lte).toHaveBeenCalledWith('usage_date', '2026-08-20');
  });

  it('carries the detail columns through to the insert', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row({ resource_id: 'i-xyz' })], errors: [] });
    const { client, insert } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(insert.mock.calls[0][0][0]).toMatchObject({
      resource_id: 'i-xyz',
      source_file_id: 'file-1',
      period_id: 'period-1',
      company_id: 'company-1',
      cloud_provider: 'aws',
    });
  });

  it('marks the file row errored and inserts nothing when the parse yields no rows', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [], errors: ['Unrecognised header row.'] });
    const { client, insert, update } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result.status).toBe('error');
    expect(result.errors).toEqual(['Unrecognised header row.']);
    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  // parseCostFile throws on corrupt binary rather than returning an error, and
  // the file row must never be left stuck at 'processing'.
  it('marks the file row errored when the parser throws', async () => {
    (parseCostFile as jest.Mock).mockImplementation(() => {
      throw new Error('Corrupted zip');
    });
    const { client, update } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toContain('Corrupted zip');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('marks the file row processed with its row count on success', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row()], errors: [] });
    const { client, update } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(update).toHaveBeenCalledWith({ status: 'processed', row_count: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/ingestCostFile.test.ts`
Expected: FAIL — `Cannot find module './ingestCostFile'`

- [ ] **Step 3: Write the implementation**

Create `lib/ingestCostFile.ts` by moving the body of the `try` block at `app/api/upload/route.ts:86-186` into it. The logic and its comments transfer unchanged; only the inputs and the return shape differ.

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCostFile } from './parseCostFile';
import type { CloudProvider } from './types';

export interface IngestCostFileInput {
  adminClient: SupabaseClient;
  companyId: string;
  cloudProvider: CloudProvider;
  periodId: string;
  uploadedFileId: string;
  /** One per part: a CUR run has many, an upload has one. Parsed and concatenated. */
  buffers: readonly Buffer[];
}

export interface IngestCostFileResult {
  status: 'processed' | 'error';
  rowCount?: number;
  errors?: string[];
}

/**
 * Parse cost file bytes into a period's cost_records.
 *
 * Shared by the upload route and the bucket pull so the two cannot drift on
 * the 22-column insert list or on the replace-the-range rule below.
 */
export async function ingestCostFile({
  adminClient,
  companyId,
  cloudProvider,
  periodId,
  uploadedFileId,
  buffers,
}: IngestCostFileInput): Promise<IngestCostFileResult> {
  // Best-effort throughout: if a status update fails the row may be left at
  // 'processing', but the caller is still told what happened.
  async function markError(message: string): Promise<IngestCostFileResult> {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: message })
      .eq('id', uploadedFileId);
    return { status: 'error', errors: [message] };
  }

  try {
    const rows = [];
    const errors: string[] = [];
    for (const buffer of buffers) {
      const parsed = parseCostFile(buffer);
      rows.push(...parsed.rows);
      errors.push(...parsed.errors);
    }

    if (rows.length === 0) {
      const message = errors.join(' ') || 'No valid rows found.';
      await adminClient
        .from('uploaded_files')
        .update({ status: 'error', error_message: message })
        .eq('id', uploadedFileId);
      return { status: 'error', errors };
    }

    // A re-upload for the same company/provider/date-range should replace the
    // prior data, not add to it — otherwise costs double every time a
    // corrected file is re-uploaded.
    const usageDates = rows.map((row) => row.usage_date);
    const rangeStart = usageDates.reduce((min, date) => (date < min ? date : min));
    const rangeEnd = usageDates.reduce((max, date) => (date > max ? date : max));

    const { error: deleteRecordsError } = await adminClient
      .from('cost_records')
      .delete()
      .eq('company_id', companyId)
      .eq('cloud_provider', cloudProvider)
      .eq('period_id', periodId)
      .gte('usage_date', rangeStart)
      .lte('usage_date', rangeEnd);

    if (deleteRecordsError) return markError(deleteRecordsError.message);

    const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
      rows.map((row) => ({
        company_id: companyId,
        cloud_provider: cloudProvider,
        service_name: row.service_name,
        usage_date: row.usage_date,
        cost: row.cost,
        account_id: row.account_id,
        source_file_id: uploadedFileId,
        // Explicit since Task 1 relaxed the stamping trigger: without this the
        // trigger still fills in the active period, which is right for an
        // upload and wrong for a historical month.
        period_id: periodId,
        resource_id: row.resource_id,
        resource_group: row.resource_group,
        region: row.region,
        availability_zone: row.availability_zone,
        instance_type: row.instance_type,
        database_engine: row.database_engine,
        meter_category: row.meter_category,
        meter_name: row.meter_name,
        usage_type: row.usage_type,
        operation: row.operation,
        subscription_id: row.subscription_id,
        subscription_name: row.subscription_name,
        purchase_type: row.purchase_type,
        reservation_id: row.reservation_id,
        reservation_name: row.reservation_name,
        quantity: row.quantity,
        unit: row.unit,
        unit_price: row.unit_price,
        effective_price: row.effective_price,
        currency: row.currency,
        charge_type: row.charge_type,
        tags: row.tags,
      }))
    );

    if (insertRecordsError) return markError(insertRecordsError.message);

    await adminClient
      .from('uploaded_files')
      .update({ status: 'processed', row_count: rows.length })
      .eq('id', uploadedFileId);

    return { status: 'processed', rowCount: rows.length };
  } catch (err) {
    // parseCostFile (via XLSX.read) throws on corrupted binary input rather
    // than returning an error — catch it here so the uploaded_files row never
    // gets stuck at 'processing'.
    return markError(err instanceof Error ? err.message : 'Could not process the file.');
  }
}
```

**Note on `period_id` — read this before running the tests.** The original insert omitted `period_id`, relying on the `stamp_period_cost_records` trigger to fill in the company's active period. Task 1 relaxes that trigger to stamp only when the caller leaves the column null, and this insert now passes `period_id` explicitly. For the upload route nothing changes in practice — it passes `activePeriod.id`, which is exactly what the trigger would have stamped — so its existing tests must still pass. For the pull route it is the whole point: it is what lets a historical month land in its own archived period instead of piling into the active one.

Add `period_id` to the assertion in the "carries the detail columns through" test above, replacing the `period_id: undefined` line with `period_id: 'period-1'`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/ingestCostFile.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor the upload route to call it**

In `app/api/upload/route.ts`, replace the entire `try { ... } catch { ... }` block (currently lines 86-186) with:

```ts
  const result = await ingestCostFile({
    adminClient,
    companyId,
    cloudProvider: cloudProvider as CloudProvider,
    periodId: activePeriod.id,
    uploadedFileId: uploadedFile.id,
    buffers: [fileBuffer],
  });

  if (result.status === 'error') {
    return NextResponse.json(
      { uploadedFileId: uploadedFile.id, status: 'error', errors: result.errors ?? [] },
      // The original returned 500 only for a thrown parse error and 200 for a
      // reported one. Preserve that: a thrown error carries exactly one message
      // and no rows were ever read.
      result.errors?.length === 1 && !result.rowCount ? undefined : undefined
    );
  }

  return NextResponse.json({ uploadedFileId: uploadedFile.id, status: 'processed', rowCount: result.rowCount });
```

**Then run the upload route's existing tests and let them tell you the exact status codes to preserve.** The original returned `500` from the `catch` and `200` from the in-band error paths; if the tests assert that distinction, add a `thrown: boolean` field to `IngestCostFileResult` and branch on it rather than guessing. Do not change the tests.

Add the import: `import { ingestCostFile } from '@/lib/ingestCostFile';` and remove the now-unused `parseCostFile` import.

- [ ] **Step 6: Run the upload route's tests unchanged**

Run: `npx jest __tests__ app/api components/upload`
Expected: PASS, with no edits to any existing test file. If a test fails, the extraction changed behaviour — fix the extraction, not the test.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 8: Commit**

```bash
git add lib/ingestCostFile.ts lib/ingestCostFile.test.ts app/api/upload/route.ts
git commit -m "Extract cost file ingestion from the upload route"
```

---

### Task 6: Resolve the period a month belongs in

**Files:**
- Create: `lib/periodForMonth.ts`
- Test: `lib/periodForMonth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  ```ts
  export interface PeriodTarget { periodId: string; kind: 'active' | 'archived' }
  export async function periodForMonth(
    adminClient: SupabaseClient,
    companyId: string,
    month: string,
    activePeriodId: string,
    isLatestMonth: boolean
  ): Promise<PeriodTarget>
  ```

Pull Billing archives the active period first (Task 10), so by the time this runs the active period is empty and free to take the newest month. The latest month goes there; every earlier month gets an archived period, reused if one exists.

- [ ] **Step 1: Write the failing test**

Create `lib/periodForMonth.test.ts`:

```ts
import { periodForMonth } from './periodForMonth';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeClient(existingArchive: { id: string } | null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: existingArchive, error: null });
  const select = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) }),
    }),
  });
  const insertSingle = jest.fn().mockResolvedValue({ data: { id: 'new-archived' }, error: null });
  const insert = jest.fn().mockReturnValue({ select: () => ({ single: insertSingle }) });
  const update = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });

  const client = { from: jest.fn(() => ({ select, insert, update })) };
  return { client: client as unknown as SupabaseClient, insert, update };
}

describe('periodForMonth', () => {
  it('puts the latest month in the active period', async () => {
    const { client, insert } = makeClient(null);

    const target = await periodForMonth(client, 'company-1', '2026-08-01', 'active-1', true);

    expect(target).toEqual({ periodId: 'active-1', kind: 'active' });
    expect(insert).not.toHaveBeenCalled();
  });

  // The active period is created without a month; the pull is what gives it one.
  it('stamps the billing month on the active period', async () => {
    const { client, update } = makeClient(null);

    await periodForMonth(client, 'company-1', '2026-08-01', 'active-1', true);

    expect(update).toHaveBeenCalledWith({ billing_month: '2026-08-01' });
  });

  it('reuses an existing archived period for an earlier month', async () => {
    const { client, insert } = makeClient({ id: 'archived-july' });

    const target = await periodForMonth(client, 'company-1', '2026-07-01', 'active-1', false);

    expect(target).toEqual({ periodId: 'archived-july', kind: 'archived' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('creates an archived period when none exists for that month', async () => {
    const { client, insert } = makeClient(null);

    const target = await periodForMonth(client, 'company-1', '2026-06-01', 'active-1', false);

    expect(target).toEqual({ periodId: 'new-archived', kind: 'archived' });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'company-1', status: 'archived', billing_month: '2026-06-01' })
    );
  });

  it('stamps archived_at on a period it creates, so the Archive tab can order it', async () => {
    const { client, insert } = makeClient(null);

    await periodForMonth(client, 'company-1', '2026-06-01', 'active-1', false);

    expect(insert.mock.calls[0][0].archived_at).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/periodForMonth.test.ts`
Expected: FAIL — `Cannot find module './periodForMonth'`

- [ ] **Step 3: Write the implementation**

Create `lib/periodForMonth.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PeriodTarget {
  periodId: string;
  kind: 'active' | 'archived';
}

/**
 * The period a discovered month's data belongs in.
 *
 * Pull Billing archives the active period before importing, so by the time
 * this runs the active period is empty and the newest month can take it.
 * Earlier months get an archived period of their own — reused if one already
 * exists, which is what makes a re-pull idempotent rather than duplicating
 * history.
 *
 * Archived periods are inserted directly rather than through
 * archive_billing_period(), which only ever archives the *active* period.
 */
export async function periodForMonth(
  adminClient: SupabaseClient,
  companyId: string,
  month: string,
  activePeriodId: string,
  isLatestMonth: boolean
): Promise<PeriodTarget> {
  if (isLatestMonth) {
    // A freshly created active period has no billing month until something
    // lands in it.
    await adminClient.from('billing_periods').update({ billing_month: month }).eq('id', activePeriodId);
    return { periodId: activePeriodId, kind: 'active' };
  }

  const { data: existing } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'archived')
    .eq('billing_month', month)
    .maybeSingle();

  if (existing) return { periodId: (existing as { id: string }).id, kind: 'archived' };

  const { data: created, error } = await adminClient
    .from('billing_periods')
    .insert({
      company_id: companyId,
      status: 'archived',
      billing_month: month,
      // The Archive tab orders by this, so a period created by a pull has to
      // carry one just as one closed by hand does.
      archived_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !created) {
    throw new Error(`Could not create an archived period for ${month}: ${error?.message ?? 'unknown error'}`);
  }

  return { periodId: (created as { id: string }).id, kind: 'archived' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/periodForMonth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/periodForMonth.ts lib/periodForMonth.test.ts
git commit -m "Add period resolution for a discovered billing month"
```

---

### Task 7: The object store interface and the S3 implementation

**Files:**
- Create: `lib/objectStore.ts`, `lib/objectStoreS3.ts`
- Test: `lib/objectStoreS3.test.ts`

**Interfaces:**
- Consumes: `RemoteObject`, `CurManifest` from `@/lib/types`; `collectPages` from `@/lib/awsPagination`
- Produces:
  ```ts
  export interface ObjectStore {
    list(prefix: string): Promise<RemoteObject[]>;
    get(key: string): Promise<Buffer>;
    readManifest(key: string): Promise<CurManifest | null>;
  }
  export function createS3ObjectStore(config: {
    accessKeyId: string; secretAccessKey: string; region: string; bucket: string;
  }): ObjectStore
  ```

`readManifest` lives on the store rather than in the pull route because reading it is I/O, and putting it here is what lets `discoverRuns` stay pure.

- [ ] **Step 1: Write the failing test**

Create `lib/objectStoreS3.test.ts`:

```ts
const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  ListObjectsV2Command: jest.fn((input) => ({ __type: 'list', input })),
  GetObjectCommand: jest.fn((input) => ({ __type: 'get', input })),
}));

import { createS3ObjectStore } from './objectStoreS3';

function store() {
  return createS3ObjectStore({
    accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1', bucket: 'cur-bucket',
  });
}

/** The SDK returns a stream; the store has to buffer it. */
function bodyOf(text: string) {
  return { transformToByteArray: async () => new TextEncoder().encode(text) };
}

describe('createS3ObjectStore', () => {
  beforeEach(() => send.mockReset());

  it('lists objects under the prefix, normalized', async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: 'cur/a.csv', ETag: '"abc"', Size: 120, LastModified: new Date('2026-08-05T00:00:00Z') }],
      NextContinuationToken: undefined,
    });

    const objects = await store().list('cur/');

    expect(objects).toEqual([
      { key: 'cur/a.csv', etag: 'abc', size: 120, lastModified: '2026-08-05T00:00:00.000Z' },
    ]);
  });

  // S3 quotes its ETags; the value is stored and compared, so the quotes
  // would otherwise become part of the dedupe key.
  it('strips the quotes S3 wraps around an ETag', async () => {
    send.mockResolvedValueOnce({ Contents: [{ Key: 'a.csv', ETag: '"xyz"', Size: 1 }] });

    expect((await store().list(''))[0].etag).toBe('xyz');
  });

  it('follows pagination to the end', async () => {
    send
      .mockResolvedValueOnce({ Contents: [{ Key: 'a.csv', ETag: '"1"', Size: 1 }], NextContinuationToken: 'more' })
      .mockResolvedValueOnce({ Contents: [{ Key: 'b.csv', ETag: '"2"', Size: 1 }] });

    expect((await store().list('')).map((object) => object.key)).toEqual(['a.csv', 'b.csv']);
  });

  it('downloads an object as a buffer', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf('service,cost\nEC2,10\n') });

    expect((await store().get('a.csv')).toString()).toBe('service,cost\nEC2,10\n');
  });

  it('parses a manifest', async () => {
    const manifest = { assemblyId: 'aaa', reportKeys: ['p1.csv.gz'], billingPeriod: { start: '20260801T000000.000Z', end: '20260901T000000.000Z' } };
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(manifest)) });

    expect(await store().readManifest('Manifest.json')).toEqual(manifest);
  });

  // An unreadable manifest must skip its month, not abort the whole pull.
  it('returns null for a manifest that is not valid JSON', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf('<html>access denied</html>') });

    expect(await store().readManifest('Manifest.json')).toBeNull();
  });

  it('returns null when the manifest is missing the fields it needs', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify({ assemblyId: 'aaa' })) });

    expect(await store().readManifest('Manifest.json')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/objectStoreS3.test.ts`
Expected: FAIL — `Cannot find module './objectStoreS3'`

- [ ] **Step 3: Write the interface**

Create `lib/objectStore.ts`:

```ts
import type { CurManifest, RemoteObject } from './types';

/**
 * Listing and downloading, without the pull route knowing which cloud it is
 * talking to. readManifest belongs here because reading a manifest is I/O,
 * which is what lets lib/exportDiscovery.ts stay a pure function.
 */
export interface ObjectStore {
  list(prefix: string): Promise<RemoteObject[]>;
  get(key: string): Promise<Buffer>;
  /** Null when the object is missing, unreadable, or not a manifest. */
  readManifest(key: string): Promise<CurManifest | null>;
}
```

- [ ] **Step 4: Write the S3 implementation**

Create `lib/objectStoreS3.ts`:

```ts
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { collectPages } from './awsPagination';
import type { ObjectStore } from './objectStore';
import type { CurManifest, RemoteObject } from './types';

export function createS3ObjectStore(config: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}): ObjectStore {
  const client = new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // A CUR bucket often sits outside the connection's configured region.
    // Same fix already applied to the S3 tag lookups on the Resources tab.
    followRegionRedirects: true,
  });

  async function download(key: string): Promise<Buffer> {
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const body = response.Body as { transformToByteArray: () => Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  }

  return {
    async list(prefix: string): Promise<RemoteObject[]> {
      const contents = await collectPages(
        (token) =>
          client.send(
            new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix || undefined, ContinuationToken: token })
          ),
        (page) => page.Contents ?? [],
        (page) => page.NextContinuationToken
      );

      return contents.map((object) => ({
        key: object.Key ?? '',
        // S3 quotes its ETags, and the raw value becomes part of the dedupe
        // key, so the quotes have to come off before it is stored.
        etag: (object.ETag ?? '').replace(/"/g, ''),
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      }));
    },

    get: download,

    async readManifest(key: string): Promise<CurManifest | null> {
      try {
        const parsed = JSON.parse((await download(key)).toString('utf8')) as Partial<CurManifest>;
        // A truncated or unexpected manifest should skip its month rather than
        // producing a run with no parts and no month.
        if (!Array.isArray(parsed.reportKeys) || !parsed.billingPeriod?.start) return null;
        return parsed as CurManifest;
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest lib/objectStoreS3.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/objectStore.ts lib/objectStoreS3.ts lib/objectStoreS3.test.ts
git commit -m "Add the object store interface and its S3 implementation"
```

---

### Task 8: The Azure Blob implementation

**Files:**
- Create: `lib/objectStoreAzureBlob.ts`
- Test: `lib/objectStoreAzureBlob.test.ts`

**Interfaces:**
- Consumes: `ObjectStore` from `@/lib/objectStore`
- Produces: `createAzureBlobObjectStore(config: { tenantId: string; clientId: string; clientSecret: string; account: string; container: string; }): ObjectStore`

**Container naming:** the source's `container` field holds `"account/container"`. Task 9's route splits it and passes the halves separately, so this function takes them already split.

- [ ] **Step 1: Write the failing test**

Create `lib/objectStoreAzureBlob.test.ts`:

```ts
const listBlobsFlat = jest.fn();
const downloadToBuffer = jest.fn();
const getBlockBlobClient = jest.fn(() => ({ downloadToBuffer }));
const getContainerClient = jest.fn(() => ({ listBlobsFlat, getBlockBlobClient }));

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn().mockImplementation(() => ({ getContainerClient })),
}));
jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn() }));

import { createAzureBlobObjectStore } from './objectStoreAzureBlob';

function store() {
  return createAzureBlobObjectStore({
    tenantId: 't', clientId: 'c', clientSecret: 's', account: 'acct', container: 'exports',
  });
}

async function* blobs(...items: unknown[]) {
  for (const item of items) yield item;
}

describe('createAzureBlobObjectStore', () => {
  beforeEach(() => {
    listBlobsFlat.mockReset();
    downloadToBuffer.mockReset();
  });

  it('lists blobs under the prefix, normalized', async () => {
    listBlobsFlat.mockReturnValue(
      blobs({
        name: 'exports/daily/20260801-20260831/cost.csv',
        properties: { etag: '"e1"', contentLength: 400, lastModified: new Date('2026-08-05T00:00:00Z') },
      })
    );

    expect(await store().list('exports/')).toEqual([
      {
        key: 'exports/daily/20260801-20260831/cost.csv',
        etag: 'e1',
        size: 400,
        lastModified: '2026-08-05T00:00:00.000Z',
      },
    ]);
  });

  it('passes the prefix to the listing rather than filtering after', async () => {
    listBlobsFlat.mockReturnValue(blobs());

    await store().list('exports/daily/');

    expect(listBlobsFlat).toHaveBeenCalledWith({ prefix: 'exports/daily/' });
  });

  it('downloads a blob as a buffer', async () => {
    downloadToBuffer.mockResolvedValue(Buffer.from('service,cost\n'));

    expect((await store().get('a.csv')).toString()).toBe('service,cost\n');
  });

  // Azure exports have no manifest; discovery uses the date-range folder.
  it('never returns a manifest, since Azure exports do not have one', async () => {
    expect(await store().readManifest('anything')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/objectStoreAzureBlob.test.ts`
Expected: FAIL — `Cannot find module './objectStoreAzureBlob'`

- [ ] **Step 3: Write the implementation**

Create `lib/objectStoreAzureBlob.ts`:

```ts
import { BlobServiceClient } from '@azure/storage-blob';
import { ClientSecretCredential } from '@azure/identity';
import type { ObjectStore } from './objectStore';
import type { RemoteObject } from './types';

export function createAzureBlobObjectStore(config: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  account: string;
  container: string;
}): ObjectStore {
  const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  const service = new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(config.container);

  return {
    async list(prefix: string): Promise<RemoteObject[]> {
      const objects: RemoteObject[] = [];
      // Filtering server-side rather than listing the whole container and
      // discarding: a cost export container can hold years of daily files.
      for await (const blob of container.listBlobsFlat({ prefix: prefix || undefined })) {
        objects.push({
          key: blob.name,
          etag: (blob.properties.etag ?? '').replace(/"/g, ''),
          size: blob.properties.contentLength ?? 0,
          lastModified: blob.properties.lastModified?.toISOString() ?? null,
        });
      }
      return objects;
    },

    async get(key: string): Promise<Buffer> {
      return container.getBlockBlobClient(key).downloadToBuffer();
    },

    // Azure cost exports carry no manifest — discovery reads the month from
    // the YYYYMMDD-YYYYMMDD folder instead.
    async readManifest(): Promise<null> {
      return null;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/objectStoreAzureBlob.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/objectStoreAzureBlob.ts lib/objectStoreAzureBlob.test.ts
git commit -m "Add the Azure Blob object store implementation"
```

---

### Task 9: The billing file sources settings route

**Files:**
- Create: `app/api/settings/billing-file-sources/route.ts`

**Interfaces:**
- Consumes: `requireCompanyAccess` from `@/lib/admin-guard`; `createAdminClient` from `@/lib/supabase/admin`; `BillingFileSource` from `@/lib/types`
- Produces: `GET /api/settings/billing-file-sources?companyId=` → `{ sources: BillingFileSource[] }`; `POST` → `{ source }`; `DELETE ?companyId=&sourceId=` → `{ ok: true }`

**Read `app/api/settings/aws-credentials/route.ts` first** — this route follows its shape exactly. Per project convention there are no Jest tests for API routes; this route is covered by type check, build, and Task 13's live check.

- [ ] **Step 1: Create the route**

Create `app/api/settings/billing-file-sources/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { CLOUD_PROVIDERS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

const MAX_TEXT = 200;

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('billing_file_sources')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to list billing file sources:', error);
    return NextResponse.json({ error: 'Could not load the configured buckets.' }, { status: 500 });
  }

  return NextResponse.json({ sources: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, credentialId, cloudProvider, container, prefix, label } = body as Record<string, unknown>;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }
  if (typeof credentialId !== 'string' || !credentialId) {
    return NextResponse.json({ error: 'Pick a saved connection to read the bucket with.' }, { status: 400 });
  }
  if (!CLOUD_PROVIDERS.includes(cloudProvider as CloudProvider)) {
    return NextResponse.json({ error: `cloudProvider must be one of: ${CLOUD_PROVIDERS.join(', ')}.` }, { status: 400 });
  }

  const cleanContainer = cleanText(container, MAX_TEXT);
  const cleanLabel = cleanText(label, MAX_TEXT);
  if (!cleanContainer) {
    return NextResponse.json(
      { error: 'Enter the S3 bucket name, or the Azure storage account and container as "account/container".' },
      { status: 400 }
    );
  }
  if (!cleanLabel) {
    return NextResponse.json({ error: 'Give this bucket a label.' }, { status: 400 });
  }
  // Azure needs both halves; catching it here beats a confusing 404 at pull time.
  if (cloudProvider === 'azure' && !cleanContainer.includes('/')) {
    return NextResponse.json(
      { error: 'For Azure, enter the storage account and container as "account/container".' },
      { status: 400 }
    );
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  // The connection is what the bucket is read with, so a source pointing at
  // another company's connection would read their cloud account with their
  // credentials. Checked here rather than trusted from the body.
  const { data: credential } = await adminClient
    .from('cloud_provider_credentials')
    .select('id')
    .eq('id', credentialId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!credential) {
    return NextResponse.json({ error: 'That connection does not belong to this company.' }, { status: 403 });
  }

  const { data, error } = await adminClient
    .from('billing_file_sources')
    .insert({
      company_id: companyId,
      credential_id: credentialId,
      cloud_provider: cloudProvider,
      container: cleanContainer,
      prefix: cleanText(prefix, MAX_TEXT) ?? '',
      label: cleanLabel,
      created_by: guard.userId,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to save the billing file source:', error);
    return NextResponse.json({ error: 'Could not save this bucket.' }, { status: 500 });
  }

  return NextResponse.json({ source: data });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const sourceId = request.nextUrl.searchParams.get('sourceId');
  if (!companyId || !sourceId) {
    return NextResponse.json({ error: 'companyId and sourceId are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  // Scoped by company as well as id, so an id from another company deletes nothing.
  const { error } = await adminClient
    .from('billing_file_sources')
    .delete()
    .eq('id', sourceId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Failed to delete the billing file source:', error);
    return NextResponse.json({ error: 'Could not remove this bucket.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Type check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add app/api/settings/billing-file-sources/route.ts
git commit -m "Add the billing file sources settings route"
```

---

### Task 10: The pull route

**Files:**
- Create: `app/api/billing-sources/[sourceId]/pull/route.ts`

**Interfaces:**
- Consumes: `discoverRuns` from `@/lib/exportDiscovery`; `gunzipIfNeeded`; `deriveBillingMonth`; `ingestCostFile`; `periodForMonth`; `createS3ObjectStore`; `createAzureBlobObjectStore`; `decryptCredentials` from `@/lib/cloudCredentialsCrypto`; `requireCompanyAccess`; `createAdminClient`
- Produces: `POST /api/billing-sources/[sourceId]/pull` with body `{ companyId: string; archiveFirst: boolean }` → `BillingSourcePullResult`

This is the orchestration. No Jest coverage per project convention; every piece it calls is unit-tested, and Task 13 covers it live.

- [ ] **Step 1: Create the route**

Create `app/api/billing-sources/[sourceId]/pull/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { createS3ObjectStore } from '@/lib/objectStoreS3';
import { createAzureBlobObjectStore } from '@/lib/objectStoreAzureBlob';
import { discoverRuns } from '@/lib/exportDiscovery';
import { gunzipIfNeeded } from '@/lib/gunzipIfNeeded';
import { deriveBillingMonth } from '@/lib/deriveBillingMonth';
import { ingestCostFile } from '@/lib/ingestCostFile';
import { periodForMonth } from '@/lib/periodForMonth';
import { parseCostFile } from '@/lib/parseCostFile';
import type { ObjectStore } from '@/lib/objectStore';
import type { BillingSourcePullRun, BillingSourcePullResult, CloudProvider, ExportRun } from '@/lib/types';

// A pull downloads and parses a year of exports; the default 15s would cut it
// off mid-import. Matches the Azure Cost Details route.
export const maxDuration = 300;

// Caps. Each one is reported when it bites — a run silently dropped would
// make the report claim a completeness it does not have.
const MAX_RUNS = 12;
const MAX_PARTS_PER_RUN = 200;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

/** Names the role rather than echoing the SDK, which is the usual cause of a first pull failing. */
function permissionHint(provider: CloudProvider, err: unknown): string {
  const message = errorMessage(err);
  const status = (err as { statusCode?: number; $metadata?: { httpStatusCode?: number } });
  const denied = status?.statusCode === 403 || status?.$metadata?.httpStatusCode === 403;
  if (!denied) return message;

  return provider === 'aws'
    ? `${message} The credential needs s3:ListBucket on the bucket and s3:GetObject on its contents.`
    : `${message} The app registration needs the Storage Blob Data Reader role on the storage account — a data-plane role the Reader and Cost Management Reader roles do not grant.`;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const body = await request.json();
  const companyId = body?.companyId;
  const archiveFirst = body?.archiveFirst === true;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  const { data: source } = await adminClient
    .from('billing_file_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!source) {
    return NextResponse.json({ error: 'That bucket is not configured for this company.' }, { status: 404 });
  }

  const { data: credRow } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('id', source.credential_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!credRow) {
    return NextResponse.json({ error: 'The connection this bucket uses no longer exists.' }, { status: 400 });
  }

  const provider = source.cloud_provider as CloudProvider;
  let store: ObjectStore;
  try {
    const secrets = decryptCredentials(credRow.encrypted_payload);
    if (provider === 'aws') {
      store = createS3ObjectStore({
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        region: credRow.region ?? 'us-east-1',
        bucket: source.container,
      });
    } else if (provider === 'azure') {
      const [account, container] = String(source.container).split('/');
      store = createAzureBlobObjectStore({
        tenantId: secrets.tenantId,
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        account,
        container,
      });
    } else {
      return NextResponse.json({ error: `Pulling from a ${provider} bucket is not supported yet.` }, { status: 400 });
    }
  } catch (err) {
    console.error('Failed to build the object store:', err);
    return NextResponse.json({ error: 'Could not read the stored credentials for this bucket.' }, { status: 500 });
  }

  // --- Archive first, so the newest month can take the active period ---
  if (archiveFirst) {
    const { data: activeRows } = await adminClient
      .from('cost_records')
      .select('id')
      .eq('company_id', companyId)
      .limit(1);

    // An empty active period is not archived: there is nothing to preserve
    // and it would leave a blank period in the Archive tab.
    if ((activeRows ?? []).length > 0) {
      const archiveResponse = await fetch(new URL('/api/periods/archive', request.nextUrl.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: request.headers.get('cookie') ?? '' },
        body: JSON.stringify({ companyId }),
      });
      if (!archiveResponse.ok) {
        const archiveBody = await archiveResponse.json().catch(() => ({}));
        return NextResponse.json(
          { error: archiveBody.error ?? 'Could not archive the current period before pulling.' },
          { status: 500 }
        );
      }
    }
  }

  const { data: activePeriod } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .single();

  if (!activePeriod) {
    return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
  }

  // --- Discover ---
  let discovered: ExportRun[];
  try {
    const objects = await store.list(source.prefix ?? '');
    discovered = await discoverRuns(provider, objects, (key) => store.readManifest(key));
  } catch (err) {
    return NextResponse.json({ error: permissionHint(provider, err) }, { status: 502 });
  }

  const runs: BillingSourcePullRun[] = [];

  // Newest first, so the 12-run cap keeps the most recent year rather than
  // whichever months the listing happened to return first.
  discovered.sort((a, b) => (b.month ?? '').localeCompare(a.month ?? ''));

  const withinCap = discovered.slice(0, MAX_RUNS);
  for (const dropped of discovered.slice(MAX_RUNS)) {
    runs.push({
      key: dropped.key,
      month: dropped.month,
      status: 'skipped',
      reason: `Older than the ${MAX_RUNS}-month limit. Get earlier months from the provider's console.`,
    });
  }

  // --- Skip runs already ingested, by (source, key, etag) ---
  const { data: alreadyIngested } = await adminClient
    .from('uploaded_files')
    .select('source_object_key, source_object_etag')
    .eq('source_id', sourceId);

  const seen = new Set((alreadyIngested ?? []).map((row) => `${row.source_object_key}::${row.source_object_etag}`));

  const pending = withinCap.filter((run) => {
    if (!seen.has(`${run.key}::${run.etag}`)) return true;
    runs.push({ key: run.key, month: run.month, status: 'skipped', reason: 'Already ingested.' });
    return false;
  });

  // The latest month takes the active period; every earlier month gets an
  // archived one. Computed across everything still pending so the assignment
  // does not depend on processing order.
  const latestMonth = pending.map((run) => run.month).filter(Boolean).sort().pop() ?? null;

  let bytesUsed = 0;

  for (const run of pending) {
    try {
      if (run.parts.length > MAX_PARTS_PER_RUN) {
        runs.push({ key: run.key, month: run.month, status: 'skipped', reason: `More than ${MAX_PARTS_PER_RUN} parts in one run.` });
        continue;
      }
      if (bytesUsed + run.totalBytes > MAX_TOTAL_BYTES) {
        runs.push({ key: run.key, month: run.month, status: 'skipped', reason: 'Would exceed this pull’s size limit. Pull again to continue.' });
        continue;
      }

      const buffers: Buffer[] = [];
      for (const part of run.parts) {
        buffers.push(gunzipIfNeeded(part, await store.get(part)));
      }
      bytesUsed += run.totalBytes;

      // The month decides the period, so it has to be settled before anything
      // is written. A manifest that disagrees with its own contents fails the
      // run rather than importing into the wrong month.
      const derived = deriveBillingMonth(buffers.flatMap((buffer) => parseCostFile(buffer).rows));
      if (run.month && derived && run.month !== derived) {
        runs.push({
          key: run.key,
          month: run.month,
          status: 'failed',
          reason: `The export says ${run.month} but its rows are mostly ${derived}.`,
        });
        continue;
      }

      const month = run.month ?? derived;
      if (!month) {
        runs.push({ key: run.key, month: null, status: 'failed', reason: 'Could not tell which month this file is for.' });
        continue;
      }

      const target = await periodForMonth(adminClient, companyId, month, activePeriod.id, month === latestMonth);

      const { data: fileRow, error: fileError } = await adminClient
        .from('uploaded_files')
        .insert({
          company_id: companyId,
          cloud_provider: provider,
          filename: run.key.split('/').pop() ?? run.key,
          storage_path: '',
          status: 'processing',
          uploaded_by: guard.userId,
          billing_month: month,
          period_id: target.periodId,
          source_id: sourceId,
          source_object_key: run.key,
          source_object_etag: run.etag,
        })
        .select()
        .single();

      if (fileError || !fileRow) {
        // The unique index is what makes a race with a future scheduled pull
        // safe: the loser lands here rather than importing a second copy.
        runs.push({ key: run.key, month, status: 'skipped', reason: 'Already ingested by another pull.' });
        continue;
      }

      const result = await ingestCostFile({
        adminClient,
        companyId,
        cloudProvider: provider,
        periodId: target.periodId,
        uploadedFileId: fileRow.id,
        buffers,
      });

      runs.push(
        result.status === 'processed'
          ? { key: run.key, month, status: 'imported', periodKind: target.kind, rowCount: result.rowCount }
          : { key: run.key, month, status: 'failed', reason: (result.errors ?? []).join(' ') || 'Import failed.' }
      );
    } catch (err) {
      // One bad run never aborts the pull.
      runs.push({ key: run.key, month: run.month, status: 'failed', reason: permissionHint(provider, err) });
    }
  }

  const summary: BillingSourcePullResult = {
    runs,
    imported: runs.filter((run) => run.status === 'imported').length,
    skipped: runs.filter((run) => run.status === 'skipped').length,
    failed: runs.filter((run) => run.status === 'failed').length,
  };

  await adminClient
    .from('billing_file_sources')
    .update({ last_pulled_at: new Date().toISOString(), last_pull_summary: summary })
    .eq('id', sourceId);

  return NextResponse.json(summary);
}
```

- [ ] **Step 2: Type check, lint and build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no errors; the build's route list includes `/api/billing-sources/[sourceId]/pull`

- [ ] **Step 3: Commit**

```bash
git add app/api/billing-sources/[sourceId]/pull/route.ts
git commit -m "Add the bucket pull route"
```

---

### Task 11: The billing file sources settings panel

**Files:**
- Create: `components/settings/BillingFileSourcesPanel.tsx`, `.module.css`, `.test.tsx`
- Modify: `components/settings/SettingsTab.tsx`

**Interfaces:**
- Consumes: `GET`/`POST`/`DELETE /api/settings/billing-file-sources` from Task 9; `BillingFileSource` from `@/lib/types`
- Produces: `export default function BillingFileSourcesPanel({ companyId }: { companyId: string })`

**Read `components/settings/ConnectionsPanel.tsx` first** for this project's panel shape, and `components/shell/ArchiveTab.tsx` for the confirm-then-act delete it uses.

- [ ] **Step 1: Write the failing test**

Create `components/settings/BillingFileSourcesPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingFileSourcesPanel from './BillingFileSourcesPanel';

const source = {
  id: 'src-1',
  company_id: 'company-1',
  credential_id: 'conn-1',
  cloud_provider: 'aws',
  container: 'cur-bucket',
  prefix: 'cur/',
  label: 'Production CUR',
  enabled: true,
  schedule_enabled: false,
  last_pulled_at: null,
  created_at: '2026-08-27T00:00:00.000Z',
};

const connections = { connections: [{ id: 'conn-1', label: 'Production', region: 'us-east-1' }] };

describe('BillingFileSourcesPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('lists the configured buckets', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [source] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    render(<BillingFileSourcesPanel companyId="company-1" />);

    expect(await screen.findByText('Production CUR')).toBeInTheDocument();
    expect(screen.getByText(/cur-bucket/)).toBeInTheDocument();
  });

  it('says so plainly when no bucket is configured yet', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    render(<BillingFileSourcesPanel companyId="company-1" />);

    expect(await screen.findByText(/no buckets configured/i)).toBeInTheDocument();
  });

  it('posts a new source with the fields entered', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => connections })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ source }) })
      .mockResolvedValue({ ok: true, json: async () => ({ sources: [source] }) });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText(/no buckets configured/i);
    await user.type(screen.getByLabelText(/label/i), 'Production CUR');
    await user.type(screen.getByLabelText(/bucket|container/i), 'cur-bucket');
    await user.type(screen.getByLabelText(/prefix/i), 'cur/');
    await user.click(screen.getByRole('button', { name: /add bucket/i }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find(
        (call) => call[1]?.method === 'POST'
      );
      expect(JSON.parse(post[1].body)).toMatchObject({
        companyId: 'company-1',
        container: 'cur-bucket',
        prefix: 'cur/',
        label: 'Production CUR',
      });
    });
  });

  it('surfaces the route error rather than a generic one', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => connections })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'That connection does not belong to this company.' }) });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText(/no buckets configured/i);
    await user.type(screen.getByLabelText(/label/i), 'X');
    await user.type(screen.getByLabelText(/bucket|container/i), 'b');
    await user.click(screen.getByRole('button', { name: /add bucket/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not belong to this company');
  });

  // Deleting a source is not reversible from the UI, so it asks first.
  it('asks before deleting and does nothing until confirmed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [source] }) })
      .mockResolvedValue({ ok: true, json: async () => connections });

    const user = userEvent.setup();
    render(<BillingFileSourcesPanel companyId="company-1" />);

    await screen.findByText('Production CUR');
    await user.click(screen.getByRole('button', { name: /remove/i }));

    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/settings/BillingFileSourcesPanel.test.tsx`
Expected: FAIL — `Cannot find module './BillingFileSourcesPanel'`

- [ ] **Step 3: Write the component and its stylesheet**

Create `components/settings/BillingFileSourcesPanel.tsx` following `ConnectionsPanel.tsx`'s structure: a `useEffect` that loads `GET /api/settings/billing-file-sources?companyId=` and the provider's connections for the dropdown; a form with Label, Bucket/Container, Prefix and a connection `<select>`; a list with a Remove button that reveals a confirm-then-act prompt; `role="alert"` for errors carrying the route's own message.

Match the label copy the test queries: `Label`, a field whose label contains `Bucket` or `Container`, `Prefix`, and a submit button reading `Add bucket`. The empty state must contain the words `No buckets configured`.

Create `components/settings/BillingFileSourcesPanel.module.css` reusing the CSS custom properties the sibling panels use (`--color-bg-alt`, `--color-border`, `--muted-foreground`).

- [ ] **Step 4: Render it in the Settings tab**

In `components/settings/SettingsTab.tsx`, import the panel and render it after the existing provider panel block, passing `companyId`.

- [ ] **Step 5: Run the tests**

Run: `npx jest components/settings && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add components/settings/BillingFileSourcesPanel.tsx components/settings/BillingFileSourcesPanel.module.css components/settings/BillingFileSourcesPanel.test.tsx components/settings/SettingsTab.tsx
git commit -m "Add the billing file sources settings panel"
```

---

### Task 12: Quick Pull, Pull Billing, and the confirmation

**Files:**
- Create: `components/reports/PullBillingFromBucketModal.tsx`, `.module.css`, `.test.tsx`
- Modify: `components/reports/CostReportTab.tsx:139-143` (the actions bar), `components/reports/PullBillingModal.tsx:127` (heading)

**Interfaces:**
- Consumes: `POST /api/billing-sources/[sourceId]/pull` from Task 10; `GET /api/settings/billing-file-sources` from Task 9; `BillingSourcePullResult` from `@/lib/types`
- Produces: `export default function PullBillingFromBucketModal({ companyId, onClose, onPulled }: { companyId: string; onClose: () => void; onPulled: () => void })`

- [ ] **Step 1: Write the failing test**

Create `components/reports/PullBillingFromBucketModal.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PullBillingFromBucketModal from './PullBillingFromBucketModal';

const sources = {
  sources: [
    { id: 'src-1', label: 'Production CUR', container: 'cur-bucket', prefix: 'cur/', cloud_provider: 'aws' },
  ],
};

const pullResult = {
  runs: [
    { key: 'cur/aug/Manifest.json', month: '2026-08-01', status: 'imported', periodKind: 'active', rowCount: 128400 },
    { key: 'cur/jul/Manifest.json', month: '2026-07-01', status: 'imported', periodKind: 'archived', rowCount: 96000 },
    { key: 'cur/old/Manifest.json', month: '2025-01-01', status: 'skipped', reason: 'Older than the 12-month limit.' },
  ],
  imported: 2,
  skipped: 1,
  failed: 0,
};

function renderModal() {
  return render(<PullBillingFromBucketModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);
}

describe('PullBillingFromBucketModal', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  // Everything below the fold depends on this: the pull is destructive-adjacent
  // and must not start on open.
  it('asks for confirmation before pulling anything', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    renderModal();

    expect(await screen.findByRole('button', { name: /^ok$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('names both consequences of archiving, including the replacement', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    renderModal();

    expect(await screen.findByText(/archive/i)).toBeInTheDocument();
    expect(screen.getByText(/replaced/i)).toBeInTheDocument();
  });

  it('does nothing at all when cancelled', async () => {
    const onClose = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => sources });

    render(<PullBillingFromBucketModal companyId="company-1" onClose={onClose} onPulled={jest.fn()} />);
    await screen.findByRole('button', { name: /cancel/i });
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect((global.fetch as jest.Mock).mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('pulls with archiveFirst once confirmed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find((call) => call[1]?.method === 'POST');
      expect(post[0]).toBe('/api/billing-sources/src-1/pull');
      expect(JSON.parse(post[1].body)).toEqual({ companyId: 'company-1', archiveFirst: true });
    });
  });

  it('reports each month and where it landed', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByText(/august 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/july 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/active period/i)).toBeInTheDocument();
    expect(screen.getByText(/archived period/i)).toBeInTheDocument();
  });

  // A cap that bites silently would make the report claim a completeness it
  // does not have.
  it('shows what a cap excluded, with its reason', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({ ok: true, json: async () => pullResult });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByText(/12-month limit/i)).toBeInTheDocument();
  });

  it('tells the user to configure a bucket when none exists', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [] }) });

    renderModal();

    expect(await screen.findByText(/settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ok$/i })).not.toBeInTheDocument();
  });

  it('surfaces the route error rather than a generic one', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => sources })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'The app registration needs the Storage Blob Data Reader role.' }),
      });

    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Storage Blob Data Reader');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/reports/PullBillingFromBucketModal.test.tsx`
Expected: FAIL — `Cannot find module './PullBillingFromBucketModal'`

- [ ] **Step 3: Write the modal**

Create `components/reports/PullBillingFromBucketModal.tsx`, following `PullBillingModal.tsx` for the modal shell and its CSS module for styling. Three states:

1. **Loading sources**, then either a source picker (when several) or the single source's name.
2. **Confirmation** — the wording must state that the current period will be archived and stay readable under the Archive tab, that **an existing archive of the same month is replaced**, and that the newest month found becomes the new active period. `OK` proceeds; `Cancel` calls `onClose` having issued no POST.
3. **Result** — the per-run report grouped by month, formatting each month with `formatBillingMonth` from `@/lib/cloudProvider` so "2026-08-01" reads as "August 2026". An import shows `active period` or `archived period` and its row count; a skip or failure shows its reason verbatim.

Call `onPulled()` after a successful pull so the report behind the modal reloads.

- [ ] **Step 4: Wire up the two buttons**

In `components/reports/CostReportTab.tsx`, replace the single button at lines 139-143 with two:

```tsx
        {canPullBilling && !isReadOnly && (
          <>
            <button type="button" onClick={() => setShowPullBillingModal(true)}>
              Quick Pull
            </button>
            <button type="button" onClick={() => setShowBucketPullModal(true)}>
              Pull Billing
            </button>
          </>
        )}
```

Add `const [showBucketPullModal, setShowBucketPullModal] = useState(false);` alongside the existing modal state, and render `PullBillingFromBucketModal` when it is true, passing `companyId`, an `onClose` that clears the flag, and the same `onPulled` handler the existing modal uses.

In `components/reports/PullBillingModal.tsx:127`, change the heading from `Pull Billing from {providerLabel}` to `Quick Pull from {providerLabel}`. **Do not change the route path** `/api/{provider}/pull-billing` at line 79.

- [ ] **Step 5: Run the tests**

Run: `npx jest components/reports && npm test`
Expected: PASS. If an existing `CostReportTab` or `PullBillingModal` test asserts the old `Pull Billing` label, update that assertion to `Quick Pull` — the label genuinely changed. Do not weaken any other assertion.

- [ ] **Step 6: Commit**

```bash
git add components/reports/PullBillingFromBucketModal.tsx components/reports/PullBillingFromBucketModal.module.css components/reports/PullBillingFromBucketModal.test.tsx components/reports/CostReportTab.tsx components/reports/PullBillingModal.tsx
git commit -m "Add the Pull Billing bucket modal and rename the API pull to Quick Pull"
```

---

### Task 13: Full verification

**Files:** none — this task runs the gates and the live check.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: every suite passes, including the nine new ones (`gunzipIfNeeded`, `deriveBillingMonth`, `exportDiscovery`, `ingestCostFile`, `periodForMonth`, `objectStoreS3`, `objectStoreAzureBlob`, `BillingFileSourcesPanel`, `PullBillingFromBucketModal`) and every pre-existing one **unchanged**

- [ ] **Step 2: Type check, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors; lint clean apart from the pre-existing `LineItemsTab` warning; the build's route list includes `/api/settings/billing-file-sources` and `/api/billing-sources/[sourceId]/pull`

- [ ] **Step 3: Check the migration's pre-flight against production data BEFORE applying**

Run this against the production database and confirm it returns **zero rows**:

```sql
select company_id, billing_month, count(*)
from public.billing_periods
where status = 'archived' and billing_month is not null
group by company_id, billing_month
having count(*) > 1;
```

If it returns rows, the migration will refuse to apply. Resolve those duplicates by hand first — do not weaken the index to get past it, since the whole point is that a second writer of archived periods now exists.

- [ ] **Step 4: Apply the migration**

Apply `supabase/migrations/20260830000000_billing_file_sources.sql`. Confirm afterwards that `private.stamp_active_period()` now contains the `if new.period_id is not null then return new; end if;` guard — without it every historical month lands in the active period, silently.

- [ ] **Step 5: Live check — the part mocks cannot cover**

With a real bucket holding at least two months of exports:

1. Configure a source in Settings, then click **Pull Billing** and cancel. Confirm nothing changed — no new periods, no new files.
2. Click **Pull Billing** and confirm. Check that the newest month landed in the **active** period and the earlier months in **archived** periods, one per month, in the Archive tab.
3. Open the Line Items tab and confirm the imported rows carry their detail columns, `resource_id` included.
4. **Re-run the pull.** Every run must report as already ingested; row counts must not change.
5. Overwrite one export in the bucket and pull again. Its etag changed, so it must re-import — and the month's totals must stay right rather than doubling.
6. Point a source at a bucket the credential cannot read, and confirm the error names the IAM action (AWS) or the Storage Blob Data Reader role (Azure) rather than echoing a raw SDK message.
7. Open **Cost Leakage** for the same company and confirm the Monthly cost column is now populated — this is the payoff that Quick Pull cannot deliver.

- [ ] **Step 6: Commit any fixes**

If the live check surfaced fixes, commit them describing what the live run revealed. If nothing needed changing, say so rather than creating an empty commit.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the two-path rename → Task 12; archive-first behind a confirmation → Tasks 10 and 12; period assignment → Task 6, with the trigger change that makes it possible in Task 1; the one-archive-per-month index and its pre-flight → Tasks 1 and 13; export discovery for CUR/Azure/fallback → Task 4; gzip → Task 2; run-level dedupe → Tasks 1 and 10; the shared ingestion → Task 5; both object stores → Tasks 7 and 8; the two routes → Tasks 9 and 10; caps, all reported → Task 10; the settings panel → Task 11; permissions messaging → Task 10's `permissionHint` and Task 13's live check; the `resource_id` payoff → Task 13 step 5.7.

**One correction the spec does not yet carry.** `private.stamp_active_period()` unconditionally overwrote `period_id` with the company's active period, which would have put every historical month in the active period. Task 1 relaxes it to stamp only when the caller leaves the column null — no existing caller sets it, so nothing else changes. **The spec should be updated to record this**; it is the single most consequential thing found while writing this plan.

**Placeholder scan.** No TBD/TODO, no "similar to Task N", no code step without code. Tasks 11 and 12 describe component structure in prose rather than full JSX, but pin every string and role their tests query, which is what the implementer needs to satisfy them.

**Type consistency.** `RemoteObject`, `ExportRun`, `CurManifest`, `BillingSourcePullRun` and `BillingSourcePullResult` are defined once in Task 1 and used unchanged in Tasks 4, 7, 8, 10 and 12. `ObjectStore` has the same three methods in Tasks 7, 8 and 10. `ingestCostFile`'s input shape in Task 5 matches its call site in Task 10, including `buffers` as an array. `periodForMonth`'s five parameters in Task 6 match its call in Task 10.

