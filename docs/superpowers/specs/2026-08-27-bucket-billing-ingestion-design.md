# Bucket Billing Ingestion — Design Spec

## Overview

Cost spreadsheets reach the portal one way today: a person picks a file in the browser, picks a billing month, and uploads it (`app/api/upload/route.ts`). Most customers already have those same exports landing automatically in an S3 bucket or an Azure Blob container — AWS Cost and Usage Reports and Azure cost exports both write there on a schedule. Asking someone to download from a bucket and re-upload is manual work the portal can do itself.

This adds a second ingestion path: point a company at a bucket or container, and have the portal discover the exports in it, pull the ones it has not already ingested, and process them through the same parser and the same tables as an upload.

**It syncs every month it finds, not just the current one.** A bucket holding a year of exports produces a year of populated periods, which is what makes "onboard a new client" a single action rather than twelve manual uploads.

This supersedes the earlier draft at `~/.claude/plans/virtual-sprouting-quiche.md` in two respects, both settled deliberately: that draft imported only the active period's month and skipped the rest, and it assumed a bucket holds one file per month. Neither survives contact with a real Cost and Usage Report bucket.

## Goals

- **A pull imports every month the bucket holds**, each into its own period, so history and trends are populated without manual work.
- **Discovery understands the real export layouts** — CUR manifests and multi-part runs, Azure's cumulative daily snapshots, gzip — rather than assuming one tidy file per month.
- **A re-run is a no-op.** Ingesting the same run twice must be impossible, including under a race between a manual pull and a future scheduled one.
- **Nothing is dropped silently.** Every run in the bucket ends the pull as imported, skipped with a stated reason, or failed with a stated reason — including anything a safety cap excluded.
- **The upload path and the bucket path share one implementation.** The ingestion half is extracted from the upload route rather than reimplemented.

## Non-goals

- **No scheduling in this build.** A daily Vercel cron calling the same pull function is a thin follow-up, sketched at the end, but not built here.
- **No changes to how a user archives a period.** The archive route and its RPC keep their current behaviour; this feature creates archived periods directly for historical months, which is a different operation.
- **The active period is never auto-archived or rolled forward** — see Period assignment.
- **No GCP or Snowflake sources.** The table carries a `cloud_provider` column with those values allowed, but only AWS and Azure stores are implemented.
- **No editing a source after creation.** Create and delete only; changing a bucket means deleting the source and adding it again.

## What already exists and gets reused

The ingestion half is essentially built:

- `lib/parseCostFile.ts` — `parseCostFile(buffer: ArrayBuffer | Buffer)` returns `ParsedCostRow[]` with all 22 detail columns, reads `.xlsx` and `.csv`, and already knows AWS CUR and Azure export column spellings. A bucket file is the same bytes as an uploaded one.
- `lib/billingMonthCheck.ts` — `checkBillingMonthMatches()` enforces that every provider in one period is for the same month.
- `cloud_provider_credentials` — stores multiple labelled connections per company per provider, encrypted via `lib/cloudCredentialsCrypto.ts`, with a `metadata` jsonb for non-secret config.
- `lib/awsPagination.ts` — `collectPages()` for the S3 listing.
- `@aws-sdk/client-s3` and `@azure/identity` are already dependencies.

**One new dependency: `@azure/storage-blob`.** Azure's List Blobs REST operation returns XML, never JSON, and Node has no built-in XML parser. The SDK is first-party and sits alongside the eight `@azure/arm-*` packages already installed.

Gzip needs no dependency — Node's built-in `zlib` handles it.

## Period assignment

A period holds exactly one billing month; `checkBillingMonthMatches` enforces that across providers. Archived periods already carry a `billing_month`, and `app/api/periods/archive/route.ts` already enforces one archive per month. So "a period per month" is the model the app already runs, and a sync fills it rather than fighting it.

For each distinct month discovered:

1. If the **active period already has a billing month**, that month's runs go into the active period.
2. If the active period has **no billing month yet**, the **latest** month found becomes its month and goes there.
3. **Every other month** goes into an archived period for that month — reused if one exists, created if not.

**Rule 3 applies even to a month newer than the active period's.** Rolling the active period forward would archive work someone may be mid-review on, and the pull result gives them no way to undo it. Filing a newer month as archived is mildly surprising but harmless and reversible; silently retiring the active period is neither.

Creating an archived period is a plain insert (`status: 'archived'`, `billing_month`, `archived_at`) — the `archive_billing_period` RPC only ever archives the *active* period and is not involved.

### Strengthening the one-archive-per-month rule

Today that rule lives only in `archive/route.ts`. This feature adds a second writer of archived periods, so it moves into the database:

```sql
create unique index billing_periods_one_archive_per_month_idx
  on public.billing_periods (company_id, billing_month)
  where status = 'archived' and billing_month is not null;
```

**This migration fails if any company already has two archived periods for the same month.** The migration must therefore check first and refuse with a readable message rather than half-applying, and the duplicates must be resolved by hand before it runs. Treat that as a real deployment step, not a formality.

## Export discovery

Real buckets do not hold one file per month, which is where the earlier draft broke:

- **AWS CUR** writes `prefix/report-name/YYYYMMDD-YYYYMMDD/<assemblyId>/report-00001.csv.gz` — commonly gzipped, frequently split across numbered parts, and rewritten under a new assembly ID on each refresh. A `Manifest.json` beside the parts lists which belong to that run.
- **Azure cost exports** write `container/dir/YYYYMMDD-YYYYMMDD/<name>_<guid>.csv`. On a daily schedule each file is a *full month-to-date snapshot*, so importing all of them would import the month many times over.

`lib/exportDiscovery.ts` turns a flat object listing into a list of **runs**, and is a pure function of that listing so it is fully testable without a cloud account:

```ts
export interface ExportRun {
  /** Identifies the run for dedupe: the manifest key, or the snapshot's own key. */
  key: string;
  etag: string;
  /** Every object to download and parse, in order. */
  parts: string[];
  /** First day of the month, when the layout states it. Null means derive from contents. */
  month: string | null;
  totalBytes: number;
}
```

- **AWS** — find `Manifest.json` objects, read `assemblyId`, `reportKeys` and `billingPeriod`. Group by month, keep the **newest assembly per month**, and emit its `reportKeys` as one run's parts. The month comes from the manifest, so it is not inferred.
- **Azure** — group blobs by their `YYYYMMDD-YYYYMMDD` path segment and keep the **newest blob per folder** as a single-part run, taking the month from the folder name.
- **Fallback** — where neither shape is present (someone drops files into a bucket by hand), each `.csv`/`.xlsx`/`.csv.gz` is its own single-part run with `month: null`, to be derived from contents.

`lib/deriveBillingMonth.ts` supplies that fallback month: the calendar month holding the most `usage_date` values, ties broken toward the earlier month, null for an empty parse. It is also used to **validate** a manifest-declared month against the parsed contents; a disagreement fails that run with a stated reason rather than importing into the wrong period.

## Dedupe

`uploaded_files` gains `source_id`, `source_object_key`, `source_object_etag`, with:

```sql
create unique index uploaded_files_source_object_idx
  on public.uploaded_files (source_id, source_object_key, source_object_etag)
  where source_id is not null;
```

**The unit is the run, not the object.** `source_object_key` holds the manifest key (AWS) or the snapshot blob key (Azure), and the etag is that object's. A 40-part CUR run is one `uploaded_files` row, and a re-run skips it in one check. Key **plus** etag means a provider rewriting an export mid-month is treated as new content rather than skipped — and the index, rather than a select-then-decide check, is what makes double-processing impossible under a race.

Re-importing a month that already has data is safe on top of this: `ingestCostFile` deletes existing rows in the file's date range within that period before inserting, so a revised export replaces rather than accumulates.

## Schema

New migration `supabase/migrations/20260830000000_billing_file_sources.sql`:

```sql
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

alter table public.billing_file_sources enable row level security;
grant select, insert, update, delete on public.billing_file_sources to service_role;
```

RLS on with no authenticated policies, matching `cloud_provider_credentials` — every read and write goes through a route using `createAdminClient()`.

Plus the `uploaded_files` columns and both unique indexes described above.

## Modules

| File | Responsibility |
|---|---|
| `lib/objectStore.ts` | `ObjectStore` interface: `list(prefix)` → `RemoteObject[]`, `get(key)` → `Buffer`. The pull route never branches on provider. |
| `lib/objectStoreS3.ts` | `ListObjectsV2Command` via `collectPages`, `GetObjectCommand`. Client built with `followRegionRedirects: true`, the same fix already applied to S3 tag lookups for out-of-region buckets. |
| `lib/objectStoreAzureBlob.ts` | `BlobServiceClient` with `ClientSecretCredential` from the stored service principal. |
| `lib/exportDiscovery.ts` | Listing → `ExportRun[]`. Pure; provider-aware; where the CUR and Azure layout knowledge lives. |
| `lib/deriveBillingMonth.ts` | Month from parsed rows. Pure. |
| `lib/ingestCostFile.ts` | Extracted from the upload route: parse → derive range → delete existing rows in range → insert all 22 columns → mark the `uploaded_files` row processed or errored. |
| `lib/periodForMonth.ts` | Get-or-create the period for a month, implementing the Period assignment rules. |
| `lib/gunzipIfNeeded.ts` | Decompress when the key ends `.gz`, via Node `zlib`. |

**Extracting `ingestCostFile` is the point of the refactor, not a tidy-up.** The upload route carries roughly 100 lines of it inline; a bucket pull needs exactly the same behaviour, and two copies would drift on the 22-column insert list. `app/api/upload/route.ts` is rewritten to call it, and its existing tests must pass **unchanged** — that is what proves the extraction was behaviour-preserving.

## Routes

**`app/api/settings/billing-file-sources/route.ts`** — `GET` / `POST` / `DELETE`, following `app/api/settings/aws-credentials/route.ts`: validate → `requireCompanyAccess(companyId)` → `createAdminClient()`. A source is accepted only if its `credential_id` belongs to the same company — otherwise a client could point a source at another company's connection.

**`app/api/billing-sources/[sourceId]/pull/route.ts`** — `POST`, `export const maxDuration = 300`, matching the Azure Cost Details route.

Sequence: guard → load source and credential → decrypt → build the `ObjectStore` → `list(prefix)` → `discoverRuns()` → drop runs whose `(source_id, key, etag)` already exists → for each remaining run, in sequence: download its parts → gunzip as needed → `parseCostFile` each → concatenate rows → establish the month → `periodForMonth` → `ingestCostFile`.

Returns a per-run report:

```ts
{
  runs: Array<{
    key: string;
    month: string | null;
    status: 'imported' | 'skipped' | 'failed';
    /** Which period it landed in, for an import. */
    periodKind?: 'active' | 'archived';
    reason?: string;
    rowCount?: number;
  }>;
  imported: number;
  skipped: number;
  failed: number;
}
```

**One bad run never aborts the pull** — it is reported as `failed` and the rest continue, mirroring how the resources routes treat a single failing service.

### Caps

A pull must fail loudly rather than run for five minutes and time out mid-import. Three caps, each reported rather than silently applied:

- **runs per pull** — 24, so a first sync covers two years
- **parts per run** — 200, comfortably above a large CUR month
- **total bytes per pull** — 500 MB decompressed, sized to stay inside the 300-second budget

Anything a cap excludes appears in the report as `skipped` with a reason naming the cap. A report that says "imported 24 months" when the bucket held 36 would be a lie by omission.

## UI

**`components/settings/BillingFileSourcesPanel.tsx`**, beside `ConnectionsPanel` in the Settings tab. Lists sources with label, bucket/container, prefix and last pull. The add form picks an existing connection from a dropdown, then bucket/container, optional prefix, and a label. Delete uses the confirm-then-act shape `ArchiveTab` already uses.

A **Pull from bucket** button on each source, and the same action in `components/reports/PullBillingModal.tsx` so both pull paths sit together.

The result renders the per-run report grouped by month, because that is what people will actually read: *"August 2026 — imported into the active period, 41 parts, 128,400 rows"*, *"March 2026 — imported into an archived period"*, *"January 2026 — failed: manifest unreadable"*.

## Files

- `supabase/migrations/20260830000000_billing_file_sources.sql` — new table, the `uploaded_files` columns, both unique indexes, and the pre-flight duplicate check.
- `lib/objectStore.ts`, `lib/objectStoreS3.ts`, `lib/objectStoreAzureBlob.ts` (+ tests).
- `lib/exportDiscovery.ts`, `lib/deriveBillingMonth.ts`, `lib/periodForMonth.ts`, `lib/gunzipIfNeeded.ts` (+ tests).
- `lib/ingestCostFile.ts` (+ test) — extracted from the upload route.
- `app/api/upload/route.ts` — refactored to call `ingestCostFile`; its tests unchanged.
- `app/api/settings/billing-file-sources/route.ts`, `app/api/billing-sources/[sourceId]/pull/route.ts`.
- `components/settings/BillingFileSourcesPanel.tsx` (+ `.module.css`, `.test.tsx`); `components/reports/PullBillingModal.tsx` gains the bucket-pull action.
- `components/settings/SettingsTab.tsx` — renders the new panel.
- `lib/types.ts` — `BillingFileSource`, `ExportRun`, `BillingSourcePullResult`.
- `package.json` — add `@azure/storage-blob`.

## Scheduling (follow-up, not this build)

A single daily cron in `vercel.json` hitting `app/api/cron/pull-billing-sources/route.ts`, iterating sources with `schedule_enabled` and calling the same pull function. Guarded by comparing a `CRON_SECRET` env var against the `Authorization` header, since a Vercel cron route is publicly reachable. Hobby allows cron on all plans but caps it at once per day with jitter, and *deployment fails* if the expression would run more often — so the expression must be daily until the account is on Pro.

## Permissions the customer must grant

The most likely cause of a first pull failing:

- **AWS** — `s3:ListBucket` on the bucket and `s3:GetObject` on its contents. The `ReadOnlyAccess` policy already used for the Resources tab covers both.
- **Azure** — the **Storage Blob Data Reader** role on the storage account, for the same app registration. This is a *data-plane* role: the `Reader` and `Cost Management Reader` roles already assigned do **not** grant it. This is the same trap the Cost Management pull hit, and the pull's error message must name this role specifically rather than echoing the raw SDK error.

## Verification

- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` — checking the build's exit code directly rather than through a pipeline that can swallow it.
- **Unit tests**: `exportDiscovery` against fixture listings — a CUR tree with two assemblies for one month, a CUR run split across parts, an Azure folder of daily snapshots, a loose-files bucket, and an empty listing. `deriveBillingMonth` including a month-straddling file and an empty parse. `periodForMonth` for all three assignment rules, including a month newer than the active one. `ingestCostFile` for insert, replace-existing-range, and parse failure. Both object stores against faked clients.
- **The upload route's existing tests must pass unchanged** after the extraction.
- **Live, and the part mocks cannot cover**: a source against a real bucket holding at least two months. Confirm the newest month lands in the active period and the older ones in archived periods; that a re-run reports everything already ingested; that overwriting an export changes its etag and re-imports it; and that the Line Items tab shows the imported rows with their detail columns populated. Then confirm a bucket with no permissions produces the named-role message rather than a raw SDK error.
