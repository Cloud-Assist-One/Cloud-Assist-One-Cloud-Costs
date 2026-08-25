# Pull Billing from AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pull Billing" button (AWS only) next to the Print button on the Overview tab that fetches a chosen calendar month's cost data directly from AWS Cost Explorer instead of requiring a file upload, with an overwrite-or-archive-first confirmation.

**Architecture:** A pure date-math helper resolves a picked month into an AWS Cost Explorer `TimePeriod` (whole month if it's a past month, month-to-date if it's the current month). A new API route reuses the existing upload pipeline's patterns verbatim — the cross-provider billing-month-mismatch check (newly extracted into a shared helper so both routes stay in lockstep), the delete-then-insert re-run-replaces semantics, and the `uploaded_files` audit-trail row (its "file" is the raw Cost Explorer JSON response). A modal component drives the month/account pick → overwrite-or-archive confirmation → result flow, reusing the multi-account credentials list already built for the Resources/IAM Users dashboards.

**Tech Stack:** Next.js 16 App Router, TypeScript, `@aws-sdk/client-cost-explorer` (new dependency, same version line as the other already-installed `@aws-sdk/client-*` packages), Supabase (Postgres/Storage), Jest/RTL.

**Spec:** docs/superpowers/specs/2026-08-25-pull-billing-from-aws-design.md

## Global Constraints

- `billingMonth` is always the first day of a month, validated against `^\d{4}-\d{2}-01$` — same pattern the upload route already uses.
- AWS Cost Explorer is always called with `region: 'us-east-1'` regardless of the connection's stored region — Cost Explorer is a global service reachable only via that endpoint. Never use `credRow.region` for the Cost Explorer client.
- Cost Explorer call shape: `Granularity: 'DAILY'`, `Metrics: ['UnblendedCost']`, `GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]`, paginated via `NextPageToken` until absent.
- A day/service group with `Amount === '0'` is a valid row — never filtered out.
- This codebase's established convention (every existing `app/api/**/route.ts` file) is **no Jest coverage for API routes or for Supabase-client-coupled helpers — verified live instead**. This plan's Task 1 and Task 3 follow that same convention deliberately; it is not a skipped step.
- The account picker reuses the existing `GET /api/settings/aws-credentials?companyId=` endpoint and `AwsCredentialSummary` type (both already built by the multi-cloud credentials Foundation sub-project) — do not build a second credentials-listing endpoint.
- New `@aws-sdk/client-cost-explorer` dependency uses the same version line already pinned for every other `@aws-sdk/client-*` package in `package.json` (currently `^3.1116.0`).

---

### Task 1: Extract the billing-month-mismatch check into a shared helper

**Files:**
- Create: `lib/billingMonthCheck.ts`
- Modify: `app/api/upload/route.ts:1-14` (imports + remove local `formatMonth`), `app/api/upload/route.ts:59-86` (replace inline check with the helper call)

**Interfaces:**
- Produces: `checkBillingMonthMatches(adminClient: ReturnType<typeof createAdminClient>, periodId: string, cloudProvider: CloudProvider, billingMonth: string): Promise<{ ok: boolean; errorMessage: string | null }>` — the new Pull Billing route (Task 3) calls this exact function with the same signature.

- [ ] **Step 1: Create the shared helper**

Write `lib/billingMonthCheck.ts`:

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { CLOUD_PROVIDER_LABELS, formatBillingMonth } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

export interface BillingMonthCheckResult {
  ok: boolean;
  errorMessage: string | null;
}

// Every cloud provider's data in a period must be for the same billing
// month — otherwise the charts/Compare/trend view would silently mix
// different months together. Shared by the file-upload route and the AWS
// Pull Billing route so the two paths can't drift apart on this rule.
export async function checkBillingMonthMatches(
  adminClient: ReturnType<typeof createAdminClient>,
  periodId: string,
  cloudProvider: CloudProvider,
  billingMonth: string
): Promise<BillingMonthCheckResult> {
  const { data: otherProviderFiles, error } = await adminClient
    .from('uploaded_files')
    .select('cloud_provider, billing_month')
    .eq('period_id', periodId)
    .eq('status', 'processed')
    .neq('cloud_provider', cloudProvider)
    .not('billing_month', 'is', null);

  if (error) {
    return { ok: false, errorMessage: "Could not verify this period's billing month." };
  }

  const mismatch = (otherProviderFiles ?? []).find((f) => f.billing_month !== billingMonth);
  if (mismatch) {
    return {
      ok: false,
      errorMessage:
        `${CLOUD_PROVIDER_LABELS[cloudProvider]} is billed for ${formatBillingMonth(billingMonth)}, but ` +
        `${CLOUD_PROVIDER_LABELS[mismatch.cloud_provider as CloudProvider]} in this period is for ` +
        `${formatBillingMonth(mismatch.billing_month as string)}. Every provider in a period must be for the same ` +
        `billing month — archive this period and start a new one, then re-upload every provider for the same month.`,
    };
  }

  return { ok: true, errorMessage: null };
}
```

- [ ] **Step 2: Update the upload route to use it**

In `app/api/upload/route.ts`, change the imports at the top of the file from:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCostFile } from '@/lib/parseCostFile';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

function formatMonth(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
```

to:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCostFile } from '@/lib/parseCostFile';
import { checkBillingMonthMatches } from '@/lib/billingMonthCheck';
import { CLOUD_PROVIDERS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';
```

Then replace this block (the cross-provider mismatch check, currently between the active-period lookup and the Storage upload):

```ts
  // Every cloud provider's data in a period must be for the same billing
  // month — otherwise the charts/Compare/trend view would silently mix
  // different months together. Check before touching Storage or the DB.
  const { data: otherProviderFiles, error: otherFilesError } = await adminClient
    .from('uploaded_files')
    .select('cloud_provider, billing_month')
    .eq('period_id', activePeriod.id)
    .eq('status', 'processed')
    .neq('cloud_provider', cloudProvider)
    .not('billing_month', 'is', null);

  if (otherFilesError) {
    return NextResponse.json({ error: 'Could not verify this period\'s billing month.' }, { status: 500 });
  }

  const mismatch = (otherProviderFiles ?? []).find((f) => f.billing_month !== billingMonth);
  if (mismatch) {
    return NextResponse.json(
      {
        error:
          `${CLOUD_PROVIDER_LABELS[cloudProvider as CloudProvider]} is billed for ${formatMonth(billingMonth)}, but ` +
          `${CLOUD_PROVIDER_LABELS[mismatch.cloud_provider as CloudProvider]} in this period is for ` +
          `${formatMonth(mismatch.billing_month as string)}. Every provider in a period must be for the same ` +
          `billing month — archive this period and start a new one, then re-upload every provider for the same month.`,
      },
      { status: 409 }
    );
  }
```

with:

```ts
  const monthCheck = await checkBillingMonthMatches(adminClient, activePeriod.id, cloudProvider as CloudProvider, billingMonth);
  if (!monthCheck.ok) {
    return NextResponse.json({ error: monthCheck.errorMessage }, { status: 409 });
  }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Per Global Constraints, this task intentionally has no Jest test — it's a behavior-preserving extraction verified by type-checking now and live upload regression in Task 6.)

- [ ] **Step 4: Commit**

```bash
git add lib/billingMonthCheck.ts app/api/upload/route.ts
git commit -m "Extract billing-month-mismatch check into a shared helper"
```

---

### Task 2: Pure date-range resolution helper

**Files:**
- Create: `lib/billingPullDateRange.ts`
- Test: `lib/billingPullDateRange.test.ts`

**Interfaces:**
- Produces: `resolvePullDateRange(billingMonth: string, today: Date): { rangeStart: string; rangeEnd: string }` — the Pull Billing route (Task 3) calls this exact function to compute the AWS Cost Explorer `TimePeriod`. `rangeEnd` is always exclusive (matches Cost Explorer's own `End` semantics): the first day of the month after `billingMonth` for a past month, or tomorrow's date for the current month. Throws if `billingMonth` is after the current calendar month.

- [ ] **Step 1: Write the failing tests**

Create `lib/billingPullDateRange.test.ts`:

```ts
import { resolvePullDateRange } from './billingPullDateRange';

describe('resolvePullDateRange', () => {
  it('returns the full month range for a past month', () => {
    const result = resolvePullDateRange('2026-06-01', new Date('2026-08-19T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-06-01', rangeEnd: '2026-07-01' });
  });

  it('returns a month-to-date range ending tomorrow for the current month', () => {
    const result = resolvePullDateRange('2026-08-01', new Date('2026-08-19T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-08-01', rangeEnd: '2026-08-20' });
  });

  it('handles a past month that crosses a year boundary', () => {
    const result = resolvePullDateRange('2025-12-01', new Date('2026-01-15T00:00:00Z'));
    expect(result).toEqual({ rangeStart: '2025-12-01', rangeEnd: '2026-01-01' });
  });

  it('rolls into the next month when today is the last day of the current month', () => {
    const result = resolvePullDateRange('2026-08-01', new Date('2026-08-31T12:00:00Z'));
    expect(result).toEqual({ rangeStart: '2026-08-01', rangeEnd: '2026-09-01' });
  });

  it('throws for a month after the current calendar month', () => {
    expect(() => resolvePullDateRange('2026-09-01', new Date('2026-08-19T12:00:00Z'))).toThrow(
      'billingMonth cannot be after the current calendar month.'
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/billingPullDateRange.test.ts`
Expected: FAIL — `Cannot find module './billingPullDateRange'` (the file doesn't exist yet).

- [ ] **Step 3: Implement the helper**

Create `lib/billingPullDateRange.ts`:

```ts
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(year: number, monthIndex0: number): string {
  return toIsoDate(new Date(Date.UTC(year, monthIndex0, 1)));
}

// billingMonth is always "YYYY-MM-01". rangeEnd is exclusive, matching AWS
// Cost Explorer's own TimePeriod.End semantics: a past month's rangeEnd is
// the first day of the following month (the whole month); the current
// month's rangeEnd is tomorrow (whatever AWS has accumulated so far).
export function resolvePullDateRange(billingMonth: string, today: Date): { rangeStart: string; rangeEnd: string } {
  const [yearStr, monthStr] = billingMonth.split('-');
  const year = Number(yearStr);
  const monthIndex0 = Number(monthStr) - 1;

  const currentYear = today.getUTCFullYear();
  const currentMonthIndex0 = today.getUTCMonth();
  const currentMonthStart = monthStart(currentYear, currentMonthIndex0);

  if (billingMonth > currentMonthStart) {
    throw new Error('billingMonth cannot be after the current calendar month.');
  }

  if (billingMonth === currentMonthStart) {
    const tomorrow = new Date(Date.UTC(currentYear, currentMonthIndex0, today.getUTCDate() + 1));
    return { rangeStart: billingMonth, rangeEnd: toIsoDate(tomorrow) };
  }

  const nextMonthStart = monthStart(year, monthIndex0 + 1);
  return { rangeStart: billingMonth, rangeEnd: nextMonthStart };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/billingPullDateRange.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/billingPullDateRange.ts lib/billingPullDateRange.test.ts
git commit -m "Add pure date-range resolution helper for Pull Billing"
```

---

### Task 3: Build the /api/aws/pull-billing route

**Files:**
- Modify: `package.json` (add `@aws-sdk/client-cost-explorer`)
- Modify: `lib/types.ts` (add `PullBillingSuccessResponse`, after the `AwsIamUsersResponse` type)
- Create: `app/api/aws/pull-billing/route.ts`

**Interfaces:**
- Consumes: `checkBillingMonthMatches` from Task 1 (`lib/billingMonthCheck.ts`), `resolvePullDateRange` from Task 2 (`lib/billingPullDateRange.ts`), `decryptCredentials<T>` from `lib/cloudCredentialsCrypto.ts` (already exists), `requireCompanyAccess` from `lib/admin-guard.ts` (already exists), `createAdminClient` from `lib/supabase/admin.ts` (already exists).
- Produces: `POST /api/aws/pull-billing` — body `{ companyId: string, credentialId: string, billingMonth: string, archiveFirst: boolean }`; on success returns `PullBillingSuccessResponse` (`{ uploadedFileId, status: 'processed', rowCount, newPeriodId? }`); on failure returns `{ error: string }` with a non-2xx status. The modal built in Task 4 calls this route with exactly this contract.

- [ ] **Step 1: Add the AWS SDK dependency**

Run: `npm install @aws-sdk/client-cost-explorer@^3.1116.0`

- [ ] **Step 2: Add the response type**

In `lib/types.ts`, immediately after the `AwsIamUsersResponse` type (after the closing `};` that follows `users: AwsResourceResult<IamUserRow>;`), add:

```ts
export interface PullBillingSuccessResponse {
  uploadedFileId: string;
  status: 'processed';
  rowCount: number;
  newPeriodId?: string;
}
```

- [ ] **Step 3: Write the route**

Create `app/api/aws/pull-billing/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { checkBillingMonthMatches } from '@/lib/billingMonthCheck';
import { resolvePullDateRange } from '@/lib/billingPullDateRange';
import type { PullBillingSuccessResponse } from '@/lib/types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, credentialId, billingMonth, archiveFirst } = body as {
    companyId?: string;
    credentialId?: string;
    billingMonth?: string;
    archiveFirst?: boolean;
  };

  if (
    typeof companyId !== 'string' ||
    typeof credentialId !== 'string' ||
    typeof billingMonth !== 'string' ||
    typeof archiveFirst !== 'boolean'
  ) {
    return NextResponse.json(
      { error: 'companyId, credentialId, billingMonth, and archiveFirst are all required.' },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-01$/.test(billingMonth)) {
    return NextResponse.json({ error: 'billingMonth must be the first day of a month, e.g. 2026-08-01.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const now = new Date();
  const currentMonthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (billingMonth > currentMonthStart) {
    return NextResponse.json({ error: 'billingMonth cannot be after the current calendar month.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  let periodId: string;
  let newPeriodId: string | undefined;

  if (archiveFirst) {
    const { data: archivedId, error: archiveError } = await adminClient.rpc('archive_billing_period', {
      p_company_id: companyId,
    });
    if (archiveError || !archivedId) {
      return NextResponse.json({ error: archiveError?.message ?? 'Could not archive the current period.' }, { status: 500 });
    }
    periodId = archivedId;
    newPeriodId = archivedId;
  } else {
    const { data: activePeriod, error: activePeriodError } = await adminClient
      .from('billing_periods')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .single();
    if (activePeriodError || !activePeriod) {
      return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
    }
    periodId = activePeriod.id;
  }

  const monthCheck = await checkBillingMonthMatches(adminClient, periodId, 'aws', billingMonth);
  if (!monthCheck.ok) {
    return NextResponse.json({ error: monthCheck.errorMessage }, { status: 409 });
  }

  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('label, encrypted_payload')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError || !credRow) {
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }

  let secrets: { accessKeyId: string; secretAccessKey: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored AWS credentials.' }, { status: 500 });
  }

  const { rangeStart, rangeEnd } = resolvePullDateRange(billingMonth, now);

  const ceClient = new CostExplorerClient({
    region: 'us-east-1',
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  });

  const resultsByTime: NonNullable<GetCostAndUsageCommandOutput['ResultsByTime']> = [];
  let nextPageToken: string | undefined;
  try {
    do {
      const page: GetCostAndUsageCommandOutput = await ceClient.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: rangeStart, End: rangeEnd },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
          NextPageToken: nextPageToken,
        })
      );
      resultsByTime.push(...(page.ResultsByTime ?? []));
      nextPageToken = page.NextPageToken;
    } while (nextPageToken);
  } catch (err) {
    return NextResponse.json({ error: `AWS Cost Explorer: ${errorMessage(err)}` }, { status: 502 });
  }

  const rows: { service_name: string; usage_date: string; cost: number }[] = [];
  for (const result of resultsByTime) {
    const usageDate = result.TimePeriod?.Start;
    if (!usageDate) continue;
    for (const group of result.Groups ?? []) {
      const serviceName = group.Keys?.[0];
      const amount = group.Metrics?.UnblendedCost?.Amount;
      if (!serviceName || amount === undefined) continue;
      rows.push({ service_name: serviceName, usage_date: usageDate, cost: Number(amount) });
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'AWS Cost Explorer returned no cost data for this month.' }, { status: 502 });
  }

  const storagePath = `${companyId}/${Date.now()}-aws-cost-explorer-pull.json`;
  const { error: uploadError } = await adminClient.storage
    .from('billing-files')
    .upload(storagePath, JSON.stringify(resultsByTime), { contentType: 'application/json' });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: uploadedFile, error: insertFileError } = await adminClient
    .from('uploaded_files')
    .insert({
      company_id: companyId,
      cloud_provider: 'aws',
      filename: `AWS Cost Explorer — ${credRow.label}`,
      storage_path: storagePath,
      status: 'processing',
      uploaded_by: guard.userId,
      billing_month: billingMonth,
    })
    .select()
    .single();

  if (insertFileError || !uploadedFile) {
    return NextResponse.json({ error: insertFileError?.message ?? 'Could not record the pull.' }, { status: 500 });
  }

  const { error: deleteRecordsError } = await adminClient
    .from('cost_records')
    .delete()
    .eq('company_id', companyId)
    .eq('cloud_provider', 'aws')
    .eq('period_id', periodId)
    .gte('usage_date', rangeStart)
    .lt('usage_date', rangeEnd);

  if (deleteRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: deleteRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ error: deleteRecordsError.message }, { status: 500 });
  }

  const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
    rows.map((row) => ({
      company_id: companyId,
      cloud_provider: 'aws' as const,
      service_name: row.service_name,
      usage_date: row.usage_date,
      cost: row.cost,
      account_id: null,
      source_file_id: uploadedFile.id,
    }))
  );

  if (insertRecordsError) {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: insertRecordsError.message })
      .eq('id', uploadedFile.id);
    return NextResponse.json({ error: insertRecordsError.message }, { status: 500 });
  }

  await adminClient.from('uploaded_files').update({ status: 'processed', row_count: rows.length }).eq('id', uploadedFile.id);

  const response: PullBillingSuccessResponse = {
    uploadedFileId: uploadedFile.id,
    status: 'processed',
    rowCount: rows.length,
    ...(newPeriodId ? { newPeriodId } : {}),
  };
  return NextResponse.json(response);
}
```

Note the delete step uses `.lt('usage_date', rangeEnd)` (strictly less than), not `.lte`, because `rangeEnd` here is exclusive — unlike the upload route's `rangeEnd`, which is the actual last usage date in the parsed file (inclusive). Using `.lte` here would incorrectly delete/miss a boundary day.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Per Global Constraints, no Jest test for this route — verified live in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/types.ts app/api/aws/pull-billing/route.ts
git commit -m "Add the AWS Pull Billing API route"
```

---

### Task 4: Build the PullBillingModal component

**Files:**
- Create: `components/reports/PullBillingModal.tsx`
- Create: `components/reports/PullBillingModal.module.css`
- Test: `components/reports/PullBillingModal.test.tsx`

**Interfaces:**
- Consumes: `GET /api/settings/aws-credentials?companyId=` (already exists, returns `{ connections: AwsCredentialSummary[] }`), `POST /api/aws/pull-billing` from Task 3.
- Produces: `PullBillingModal({ companyId: string, onClose: () => void, onPulled: (result: { rowCount: number; newPeriodId?: string }) => void })` — Task 5 renders this from `CostReportTab`.

- [ ] **Step 1: Write the failing tests**

Create `components/reports/PullBillingModal.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PullBillingModal from './PullBillingModal';

const oneConnection = [{ id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' }];
const twoConnections = [
  ...oneConnection,
  { id: 'conn-2', label: 'Staging', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2' },
];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe('PullBillingModal', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a message when there are no saved AWS connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: [] }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    expect(await screen.findByText(/no aws connection found/i)).toBeInTheDocument();
  });

  it('hides the account picker when there is only one connection', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: oneConnection }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    await screen.findByLabelText(/billing month/i);
    expect(screen.queryByLabelText(/account/i)).not.toBeInTheDocument();
  });

  it('shows the account picker when there is more than one connection', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ connections: twoConnections }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    expect(await screen.findByLabelText(/account/i)).toBeInTheDocument();
  });

  it('posts archiveFirst: false when Ok is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(jsonResponse({ uploadedFileId: 'file-1', status: 'processed', rowCount: 12 }));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    const year = new Date().getFullYear();
    await screen.findByLabelText(/billing month/i);
    await userEvent.selectOptions(screen.getByLabelText(/billing month/i), `${year}-01-01`);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));

    expect(await screen.findByText('Pulled 12 rows.')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/aws/pull-billing',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          companyId: 'company-1',
          credentialId: 'conn-1',
          billingMonth: `${year}-01-01`,
          archiveFirst: false,
        }),
      })
    );
  });

  it('posts archiveFirst: true when Yes, but Archive Current View is clicked, then calls onPulled/onClose on Done', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(
        jsonResponse({ uploadedFileId: 'file-1', status: 'processed', rowCount: 8, newPeriodId: 'period-2' })
      );

    const onPulled = jest.fn();
    const onClose = jest.fn();
    render(<PullBillingModal companyId="company-1" onClose={onClose} onPulled={onPulled} />);

    await screen.findByLabelText(/billing month/i);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, but Archive Current View' }));

    expect(await screen.findByText('Pulled 8 rows.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onPulled).toHaveBeenCalledWith({ rowCount: 8, newPeriodId: 'period-2' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error message when the pull fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ connections: oneConnection }))
      .mockResolvedValueOnce(jsonResponse({ error: 'AWS Cost Explorer: Access denied.' }, false));

    render(<PullBillingModal companyId="company-1" onClose={jest.fn()} onPulled={jest.fn()} />);

    await screen.findByLabelText(/billing month/i);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));

    expect(await screen.findByText('AWS Cost Explorer: Access denied.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest components/reports/PullBillingModal.test.tsx`
Expected: FAIL — `Cannot find module './PullBillingModal'`.

- [ ] **Step 3: Implement the component**

Create `components/reports/PullBillingModal.module.css`:

```css
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  position: relative;
  background: var(--color-bg-alt);
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 420px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.closeButton {
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
}

.form,
.confirm,
.result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.error {
  color: #d1274b;
  font-size: 0.875rem;
}
```

Create `components/reports/PullBillingModal.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { AwsCredentialSummary } from '@/lib/types';
import { formatBillingMonth } from '@/lib/cloudProvider';
import styles from './PullBillingModal.module.css';

interface PullBillingModalProps {
  companyId: string;
  onClose: () => void;
  onPulled: (result: { rowCount: number; newPeriodId?: string }) => void;
}

type Step = 'form' | 'confirm' | 'result';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildPullableMonthOptions(now: Date): { label: string; value: string }[] {
  const year = now.getUTCFullYear();
  const currentMonthIndex0 = now.getUTCMonth();
  return MONTH_NAMES.slice(0, currentMonthIndex0 + 1).map((name, i) => ({
    label: `${name} ${year}`,
    value: `${year}-${String(i + 1).padStart(2, '0')}-01`,
  }));
}

export default function PullBillingModal({ companyId, onClose, onPulled }: PullBillingModalProps) {
  const monthOptions = buildPullableMonthOptions(new Date());

  const [connections, setConnections] = useState<AwsCredentialSummary[] | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [billingMonth, setBillingMonth] = useState(monthOptions[monthOptions.length - 1].value);
  const [step, setStep] = useState<Step>('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [newPeriodId, setNewPeriodId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function loadConnections() {
      try {
        const res = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
        const body = await res.json();
        if (cancelled) return;
        const list = (body.connections ?? []) as AwsCredentialSummary[];
        setConnections(list);
        if (list.length > 0) setSelectedCredentialId(list[0].id);
      } catch {
        if (!cancelled) setConnectionsError('Could not load your AWS connections.');
      }
    }

    loadConnections();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function submitPull(archiveFirst: boolean) {
    setStep('result');
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/aws/pull-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, credentialId: selectedCredentialId, billingMonth, archiveFirst }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSubmitError(body.error ?? 'Could not pull billing data.');
        setSubmitting(false);
        return;
      }
      setRowCount(body.rowCount);
      setNewPeriodId(body.newPeriodId);
      setSubmitting(false);
    } catch {
      setSubmitError('Could not pull billing data. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Pull AWS Billing">
      <div className={styles.dialog}>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          ×
        </button>

        {connections === null && !connectionsError && <p>Loading your AWS connections…</p>}

        {connectionsError && (
          <p role="alert" className={styles.error}>
            {connectionsError}
          </p>
        )}

        {connections !== null && connections.length === 0 && (
          <p>No AWS connection found. Add one in the Settings tab first.</p>
        )}

        {connections !== null && connections.length > 0 && step === 'form' && (
          <div className={styles.form}>
            <h3>Pull Billing from AWS</h3>

            <label htmlFor="pull-billing-month">Billing month</label>
            <select id="pull-billing-month" value={billingMonth} onChange={(e) => setBillingMonth(e.target.value)}>
              {monthOptions.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>

            {connections.length > 1 && (
              <>
                <label htmlFor="pull-billing-account">Account</label>
                <select
                  id="pull-billing-account"
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </>
            )}

            <p>This will overwrite the current AWS Billing Overview data for the selected month.</p>

            <div className={styles.actions}>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={() => setStep('confirm')}>
                Next
              </button>
            </div>
          </div>
        )}

        {connections !== null && connections.length > 0 && step === 'confirm' && (
          <div className={styles.confirm}>
            <p>This will overwrite the current AWS Billing Overview data for {formatBillingMonth(billingMonth)}.</p>
            <div className={styles.actions}>
              <button type="button" onClick={() => setStep('form')}>
                Back
              </button>
              <button type="button" onClick={() => submitPull(false)}>
                Ok
              </button>
              <button type="button" onClick={() => submitPull(true)}>
                Yes, but Archive Current View
              </button>
            </div>
          </div>
        )}

        {step === 'result' && (
          <div className={styles.result}>
            {submitting ? (
              <p>Pulling billing data…</p>
            ) : submitError ? (
              <>
                <p role="alert" className={styles.error}>
                  {submitError}
                </p>
                <div className={styles.actions}>
                  <button type="button" onClick={() => setStep('confirm')}>
                    Try Again
                  </button>
                  <button type="button" onClick={onClose}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p role="status">Pulled {rowCount} rows.</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() => {
                      onPulled({ rowCount: rowCount ?? 0, newPeriodId });
                      onClose();
                    }}
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest components/reports/PullBillingModal.test.tsx`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add components/reports/PullBillingModal.tsx components/reports/PullBillingModal.module.css components/reports/PullBillingModal.test.tsx
git commit -m "Add the PullBillingModal component"
```

---

### Task 5: Wire Pull Billing into CostReportTab and AppShell

**Files:**
- Modify: `components/reports/CostReportTab.tsx`
- Modify: `components/reports/CostReportTab.module.css`
- Modify: `components/reports/CostReportTab.test.tsx`
- Modify: `components/shell/AppShell.tsx`

**Interfaces:**
- Consumes: `PullBillingModal` from Task 4.
- Produces: `CostReportTab` gains two new optional props — `isReadOnly?: boolean` and `onPeriodArchived?: (newPeriodId: string) => void` — which `AppShell.tsx` now passes on every `CostReportTab` render.

- [ ] **Step 1: Write the failing tests**

In `components/reports/CostReportTab.test.tsx`, add these imports right after the existing ones:

```tsx
import userEvent from '@testing-library/user-event';
```

Add this mock right after the `recharts` mock (before the `describe` block):

```tsx
jest.mock('./PullBillingModal', () => ({
  __esModule: true,
  default: ({
    onClose,
    onPulled,
  }: {
    onClose: () => void;
    onPulled: (result: { rowCount: number; newPeriodId?: string }) => void;
  }) => (
    <div>
      pull-billing-modal-content
      <button type="button" onClick={onClose}>
        close-modal
      </button>
      <button type="button" onClick={() => onPulled({ rowCount: 5 })}>
        simulate-pulled
      </button>
      <button type="button" onClick={() => onPulled({ rowCount: 5, newPeriodId: 'period-2' })}>
        simulate-pulled-with-archive
      </button>
    </div>
  ),
}));
```

Add these tests inside the existing `describe('CostReportTab', ...)` block:

```tsx
  it('shows a Pull Billing button for AWS that opens the modal', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);

    const button = await screen.findByRole('button', { name: /pull billing/i });
    await userEvent.click(button);

    expect(screen.getByText('pull-billing-modal-content')).toBeInTheDocument();
  });

  it('does not show a Pull Billing button for non-AWS providers', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="azure" periodId="period-1" />);

    await screen.findByText(/no cost data for this period/i);
    expect(screen.queryByRole('button', { name: /pull billing/i })).not.toBeInTheDocument();
  });

  it('does not show a Pull Billing button when the period is read-only', async () => {
    loadRecords.mockResolvedValueOnce({ data: [] });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" isReadOnly />);

    await screen.findByText(/no cost data for this period/i);
    expect(screen.queryByRole('button', { name: /pull billing/i })).not.toBeInTheDocument();
  });

  it('reloads cost records after a successful pull', async () => {
    loadRecords
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: 'r1', service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 20 }],
      });

    render(<CostReportTab companyId="company-1" cloudProvider="aws" periodId="period-1" />);
    await screen.findByText(/no cost data for this period/i);

    await userEvent.click(screen.getByRole('button', { name: /pull billing/i }));
    await userEvent.click(screen.getByRole('button', { name: 'simulate-pulled' }));

    expect(await screen.findByText('$20.00')).toBeInTheDocument();
    expect(loadRecords).toHaveBeenCalledTimes(2);
  });

  it('calls onPeriodArchived when the pull result includes a newPeriodId', async () => {
    const onPeriodArchived = jest.fn();
    loadRecords.mockResolvedValue({ data: [] });

    render(
      <CostReportTab
        companyId="company-1"
        cloudProvider="aws"
        periodId="period-1"
        onPeriodArchived={onPeriodArchived}
      />
    );
    await screen.findByText(/no cost data for this period/i);

    await userEvent.click(screen.getByRole('button', { name: /pull billing/i }));
    await userEvent.click(screen.getByRole('button', { name: 'simulate-pulled-with-archive' }));

    expect(onPeriodArchived).toHaveBeenCalledWith('period-2');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: FAIL — the new tests fail because there's no "Pull Billing" button yet (the existing 3 tests still pass unchanged).

- [ ] **Step 3: Implement the CostReportTab changes**

In `components/reports/CostReportTab.tsx`, change the imports and props interface:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { createClient } from '@/lib/supabase/client';
import type { CloudProvider, CostRecord } from '@/lib/types';
import { aggregateByDate, aggregateByService, totalCost } from '@/lib/reportAggregation';
import { formatBillingMonth } from '@/lib/cloudProvider';
import PullBillingModal from './PullBillingModal';
import styles from './CostReportTab.module.css';

interface CostReportTabProps {
  companyId: string;
  cloudProvider: CloudProvider;
  periodId: string;
  isReadOnly?: boolean;
  onServiceClick?: (serviceName: string) => void;
  onPeriodArchived?: (newPeriodId: string) => void;
}
```

Change the function signature and add the new state, keeping everything else in the two existing `useEffect`s the same except for adding `refreshKey` to each dependency array:

```tsx
export default function CostReportTab({
  companyId,
  cloudProvider,
  periodId,
  isReadOnly,
  onServiceClick,
  onPeriodArchived,
}: CostReportTabProps) {
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [billingMonth, setBillingMonth] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPullBillingModal, setShowPullBillingModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
```

Update the first `useEffect`'s dependency array from `[companyId, cloudProvider, periodId]` to `[companyId, cloudProvider, periodId, refreshKey]`, and the second `useEffect`'s dependency array the same way.

Add this handler right after the two `useEffect`s (before the `const byDate = ...` memo line):

```tsx
  const handlePulled = useCallback(
    (result: { rowCount: number; newPeriodId?: string }) => {
      setRefreshKey((k) => k + 1);
      if (result.newPeriodId) {
        onPeriodArchived?.(result.newPeriodId);
      }
    },
    [onPeriodArchived]
  );
```

Replace the current render's opening (the `<button>Print</button>` line and everything before the `billingMonth` paragraph):

```tsx
  return (
    <div className={styles.wrapper}>
      <div className={`${styles.actionsBar} print-hidden`}>
        {cloudProvider === 'aws' && !isReadOnly && (
          <button type="button" onClick={() => setShowPullBillingModal(true)}>
            Pull Billing
          </button>
        )}
        <button type="button" className={styles.printButton} onClick={() => window.print()}>
          Print
        </button>
      </div>

      {showPullBillingModal && (
        <PullBillingModal
          companyId={companyId}
          onClose={() => setShowPullBillingModal(false)}
          onPulled={(result) => {
            handlePulled(result);
            setShowPullBillingModal(false);
          }}
        />
      )}

      {billingMonth && <p className={styles.billingMonth}>Billing month: {formatBillingMonth(billingMonth)}</p>}
```

Everything after that line (the loading/error/empty/chart/table JSX) stays exactly as it already is.

In `components/reports/CostReportTab.module.css`, replace:

```css
.printButton {
  align-self: flex-end;
}
```

with:

```css
.actionsBar {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest components/reports/CostReportTab.test.tsx`
Expected: PASS, all 8 tests green (3 existing + 5 new).

- [ ] **Step 5: Wire AppShell**

In `components/shell/AppShell.tsx`, every `<CostReportTab ...>` render gets `isReadOnly={viewingArchivedPeriod}` added. The AWS overview render (inside the `activeTab === 'aws'` block) additionally gets `onPeriodArchived={(newPeriodId) => setActivePeriodId(newPeriodId)}`.

Change:

```tsx
                  {awsSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="aws"
                      periodId={periodIdForReports}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                    />
```

to:

```tsx
                  {awsSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="aws"
                      periodId={periodIdForReports}
                      isReadOnly={viewingArchivedPeriod}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                      onPeriodArchived={(newPeriodId) => setActivePeriodId(newPeriodId)}
                    />
```

Change the Azure overview render similarly (just `isReadOnly`, no `onPeriodArchived` since Pull Billing is AWS-only and the prop is a no-op for other providers):

```tsx
                  {azureSubTab === 'overview' ? (
                    <CostReportTab
                      companyId={effectiveCompanyId}
                      cloudProvider="azure"
                      periodId={periodIdForReports}
                      isReadOnly={viewingArchivedPeriod}
                      onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                    />
```

And the `gcp`/`snowflake` renders the same way — add `isReadOnly={viewingArchivedPeriod}` to each:

```tsx
              {activeTab === 'gcp' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="gcp"
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
              {activeTab === 'snowflake' && (
                <CostReportTab
                  companyId={effectiveCompanyId}
                  cloudProvider="snowflake"
                  periodId={periodIdForReports}
                  isReadOnly={viewingArchivedPeriod}
                  onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
                />
              )}
```

- [ ] **Step 6: Run the full suite, type-check, lint**

Run: `npm test`
Expected: all tests pass, including the 5 new `CostReportTab` tests and the 6 `PullBillingModal` tests.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/reports/CostReportTab.tsx components/reports/CostReportTab.module.css components/reports/CostReportTab.test.tsx components/shell/AppShell.tsx
git commit -m "Add the Pull Billing button and wire it into CostReportTab/AppShell"
```

---

### Task 6: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (0 failures).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (A brand-new route folder can show a transient `RouteContext` typed-route error until `npm run build` regenerates `.next/types` — run the build step below before concluding there's a real error.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Fix anything found, otherwise this task needs no commit**

If any step above required a fix, commit it with a message describing the fix. If everything was already clean, no commit is needed for this task.

---

## Post-plan: live verification (not a subagent task)

This step needs a real browser session against the user's own real AWS connection (the same one already used to verify the Resources/IAM Users dashboards) — hand this to the orchestrating session directly rather than a subagent:

1. Sign in, open the AWS tab's Overview sub-tab, confirm the "Pull Billing" button appears next to Print, and confirm it does **not** appear on Azure/GCP/Snowflake or while viewing an archived period.
2. Pull a past month: confirm the confirm-step wording, click "Ok", confirm `cost_records` appear and the chart/table render, and confirm a new `uploaded_files` row shows up in the Uploaded Files tab with the "AWS Cost Explorer — <label>" filename.
3. Pull the current month: confirm it does not error just because the month is incomplete, and that the resulting data stops at "yesterday" (today's data may or may not be present depending on how current AWS's data is).
4. Exercise "Yes, but Archive Current View": confirm a new period appears in the Archive tab with the old data frozen, and the Overview view switches to the fresh period.
5. Exercise the plain overwrite path on a period that already has AWS data from a prior pull: confirm the old range's records are replaced, not duplicated (row count matches a fresh pull, not double).
6. Remind the user to rotate the AWS test key afterward, consistent with this session's established rhythm.
