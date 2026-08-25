# Pull Billing Directly from AWS — Design Spec

## Overview

Uploading a billing spreadsheet is currently the only way to get cost data into a period. This adds a second path — "Pull Billing" — that fetches the data directly from a cloud provider's billing API instead, starting with AWS Cost Explorer. It reuses the existing `uploaded_files`/`cost_records` tables and the existing period/archive model exactly, so Compare, Line Items, Archive, and printing all work identically regardless of whether a period's data came from a file or a live pull.

Bundled with this change: the 12-month trend sidebar (already removed from the UI in a separate prior commit this session, for an unrelated reason — its totals grew incorrectly on repeated loads) is out of scope here; this spec is Pull Billing only.

## Goals

- A **"Pull Billing"** button on `CostReportTab`'s Overview view, next to the existing Print button, visible only when `cloudProvider === 'aws'`.
- Clicking it opens a small form: a **billing month** dropdon (current year, capped so it cannot offer a future month — there's nothing to pull yet) and, if the company has more than one saved AWS connection, an **account picker** (defaults to the only one if there's just one).
- Submitting shows a confirmation step naming the month and warning that it will overwrite existing AWS data for that month, with two explicit actions:
  - **Ok** — overwrite the current period's AWS data in place (same delete-and-replace-by-date-range semantics the upload route already uses).
  - **Yes, but Archive Current View** — archive the current period first (via the existing `archive_billing_period` RPC), then pull into the resulting fresh, empty period.
- A new `app/api/aws/pull-billing/route.ts` does the work: decrypts the chosen AWS connection, calls Cost Explorer for the resolved date range, maps results into the same row shape `parseCostFile` produces, and reuses the upload route's cross-provider billing-month-mismatch check and delete-then-insert logic.
- Every pulled batch still gets an `uploaded_files` row (so it prints/archives/audits exactly like an upload) — its "file" is the raw Cost Explorer JSON response, saved to the same Storage bucket uploads use, so the underlying data pulled is always inspectable later.

## Non-goals

- Azure/GCP/Snowflake "Pull Billing" — AWS only for this pass; the other three follow later, each via their own provider's billing API (Azure Cost Management, GCP Cloud Billing, Snowflake's usage views), as separate future work.
- No scheduling/automatic recurring pulls — this is a manual, on-demand action only.
- No changes to the manual upload flow's own UI or behavior, beyond extracting its billing-month-mismatch check into a shared helper both routes call (so the two paths can't drift apart on this rule).

## Date range resolution (the part most likely to be gotten wrong)

Given a selected `billingMonth` (`YYYY-MM-01`):
- `rangeStart = billingMonth`
- `rangeEnd`:
  - If the selected month is **before** the current calendar month: `rangeEnd` = the first day of the *next* month after `billingMonth` (a complete month — Cost Explorer's `End` is exclusive, so this correctly includes every day of the selected month).
  - If the selected month **is** the current calendar month: `rangeEnd` = **tomorrow's date** (today + 1 day) — pulls everything available so far, since AWS Cost Explorer's `End` is exclusive and today's cost data is typically still finalizing.
- The month dropdown itself never offers a month after the current one, so `rangeEnd` is never computed for a future month.

## AWS Cost Explorer call

- `@aws-sdk/client-cost-explorer`'s `CostExplorerClient`, always constructed with `region: 'us-east-1'` regardless of the connection's stored region — Cost Explorer is a global service reachable only via that endpoint.
- `GetCostAndUsageCommand({ TimePeriod: { Start: rangeStart, End: rangeEnd }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] })`.
- Paginated via `NextPageToken` — loop until it's absent, accumulating every page's `ResultsByTime` before mapping (the same category of bug just fixed for Azure AD Users' Graph pagination; must not repeat it here).
- Each `ResultsByTime[i].Groups[j]` maps to one row: `service_name` = `Keys[0]`, `usage_date` = that result's `TimePeriod.Start`, `cost` = `Number(Metrics.UnblendedCost.Amount)`, `account_id` = `null` (the pull is scoped to one connection's own account; no per-linked-account breakdown in this pass).
- A day/group with `Metrics.UnblendedCost.Amount === '0'` is still a valid row (AWS returns explicit zero-cost entries) — insert it as-is; do not filter zero-cost rows out (they're real data, and filtering would make "no usage that day" indistinguishable from "we didn't pull that day").

## API route

`app/api/aws/pull-billing/route.ts` — `POST`, body `{ companyId, credentialId, billingMonth, archiveFirst: boolean }`:

1. Validate all fields present; `billingMonth` matches `^\d{4}-\d{2}-01$`; `billingMonth` is not after the current calendar month.
2. `requireCompanyAccess(companyId)`.
3. If `archiveFirst` is true: call the same `archive_billing_period` RPC the existing `/api/periods/archive` route calls, and use its returned new period id as the target for everything below (instead of looking up the "current" active period, since archiving just changed which one that is).
4. Look up the active period (or the freshly-archived-into one from step 3).
5. Run the shared billing-month-mismatch check (extracted from `/api/upload`) against the target period's other-provider `uploaded_files` rows — if the selected month doesn't match, return 409 with the same message shape the upload route uses.
6. Look up and decrypt the AWS connection (`cloud_provider_credentials`, scoped by `company_id` + `provider='aws'` + `id=credentialId`) — identical pattern to the Resources/IAM Users routes.
7. Resolve the date range per the rules above.
8. Call Cost Explorer (with pagination), map to rows. If AWS returns an error (e.g. missing `ce:GetCostAndUsage` permission) or zero groups across the whole range, treat it as a route-level error (400/502 with the AWS message) — there's no "per-row" error concept here the way file-parsing has, so this can't partially succeed.
9. Serialize the raw Cost Explorer pages (`ResultsByTime` arrays) to JSON, upload to the `billing-files` Storage bucket at `${companyId}/${Date.now()}-aws-cost-explorer-pull.json`.
10. Insert an `uploaded_files` row: `filename: "AWS Cost Explorer — ${connectionLabel}"`, `storage_path` = the path from step 9, `status: 'processing'` → same processed/error update pattern the upload route uses, `billing_month: billingMonth`.
11. Delete existing `cost_records` for `company_id` + `cloud_provider: 'aws'` + `period_id` + the resolved date range (identical to upload's re-run-replaces semantics), then insert the mapped rows with `source_file_id` pointing at the new `uploaded_files` row.
12. Mark the `uploaded_files` row `processed` with `row_count`, return `{ uploadedFileId, status: 'processed', rowCount, newPeriodId? }` (the last field present only when `archiveFirst` was used, so the client knows to switch its "viewing period" to the fresh one).

## UI

- `components/reports/CostReportTab.tsx`: add a "Pull Billing" button next to Print, rendered only when `cloudProvider === 'aws'`. Clicking it opens `PullBillingModal` (new component).
- `components/reports/PullBillingModal.tsx` (new): three-step flow in one component —
  1. **Form step**: billing-month dropdown (reusing the same month-option-building idea as `UploadForm`, capped to not exceed the current month) + an account `<select>` populated from `GET /api/settings/aws-credentials?companyId=` (hidden entirely if there's only one connection, defaulting to it silently).
  2. **Confirm step**: shows the resolved month name and the two buttons, "Ok" and "Yes, but Archive Current View".
  3. **Result step**: loading indicator while the POST is in flight, then either a success message (with row count) or the error message from the route.
- On success, the modal calls an `onPulled` callback (mirroring `UploadForm`'s `onUploaded`) so `CostReportTab` can refetch its cost data — and if the response included `newPeriodId`, the parent (`AppShell`) needs to know the active period changed, exactly the same situation `ArchiveTab`'s "Archive this period" button already handles today (re-check `AppShell.tsx`'s existing archive-period wiring and reuse the same callback path rather than inventing a second one).

## Verification plan

- Component tests for `PullBillingModal` (mocked `fetch`): form renders/hides the account picker correctly; confirm step shows both buttons; Ok posts `archiveFirst: false`; the archive button posts `archiveFirst: true`; success and error paths render correctly.
- No Jest coverage for the new API route (established convention) — verified live.
- A pure-function unit test for the date-range resolution logic (extract it into a small, directly-testable helper) covering: a past month → full-month range; the current month → range ending tomorow; a same-day edge case at month boundaries (e.g. resolving December for a company whose "today" is January 1st — must not happen given the dropdown, but the helper itself should still be correct in isolation).
- Live verification against the same real AWS test key/connection already used for Resources/IAM Users (Reader + ReadOnlyAccess should already cover `ce:GetCostAndUsage`, but confirm) — pull a past month, confirm cost_records appear and the Overview chart renders them; pull the current month, confirm it doesn't error just because the month is incomplete; exercise the archive-first path and confirm a new period appears in Archive with the old data frozen; exercise the plain-overwrite path on a period that already has AWS data and confirm the old range's records are replaced, not duplicated.
