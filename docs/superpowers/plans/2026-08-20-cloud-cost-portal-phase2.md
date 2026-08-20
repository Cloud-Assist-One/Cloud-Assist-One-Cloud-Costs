# Cloud Cost Review Portal — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Azure cost report tab and a cross-cloud AWS-vs-Azure comparison tab. This is the second of three phases; Phase 1 (already built and deployed) shipped login, AWS upload, and AWS reporting. Phase 3 adds the notes/todos/time-tracking review workflow and the staff Admin tab.

**Architecture:** No schema changes are needed — Phase 1's `cost_records.cloud_provider` column and RLS policies already treat `'aws'` and `'azure'` identically, and `CostReportTab` was built generically (parameterized by `cloudProvider`) specifically so this phase could reuse it unchanged. This phase is almost entirely new UI wiring plus one new component (`CompareTab`).

**Tech Stack:** Same as Phase 1 — Next.js 16, React 19, Supabase, `recharts`, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-19-cloud-cost-portal-phase1-design.md`

## Global Constraints

- This phase builds directly on top of Phase 1's completed, deployed codebase — do not re-scaffold the project or re-create any Phase 1 file. Read the existing `components/reports/CostReportTab.tsx`, `components/reports/DateRangePicker.tsx`, `lib/reportAggregation.ts`, `lib/dateRange.ts`, `lib/types.ts`, and `components/shell/AppShell.tsx` before writing anything — this plan assumes they already exist exactly as Phase 1 built them.
- No new database migration is required for this phase — Task 4's `cost_data_schema` migration from Phase 1 already supports `'azure'` end-to-end. Do not write a new migration unless a real gap is discovered while implementing.
- Follow existing project conventions established in Phase 1: CSS Modules per component, `@/*` path alias, tests co-located as `Component.test.tsx`, functional components with hooks, 2-space indentation.
- All Supabase env vars are trimmed on read — already true throughout Phase 1's code; don't regress it.

---

## Task 1: Compare tab

**Files:**
- Create: `components/reports/CompareTab.tsx`
- Create: `components/reports/CompareTab.module.css`
- Create: `components/reports/CompareTab.test.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`, `CostRecord` type from `@/lib/types`, `totalCost` from `@/lib/reportAggregation`, `computeDateRange`/`shiftReferenceDate`/`Granularity` from `@/lib/dateRange`, `DateRangePicker` from `./DateRangePicker` — all already exist from Phase 1, unchanged.
- Produces: `CompareTab` (default export, props `{ companyId: string }`) — consumed by `AppShell` in Task 2 of this phase.

- [ ] **Step 1: Write the failing test**

`components/reports/CompareTab.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import CompareTab from './CompareTab';

const loadRecords = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            lte: (...args: unknown[]) => loadRecords(...args),
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

  it('shows separate AWS and Azure totals for the current range', async () => {
    loadRecords.mockResolvedValueOnce({
      data: [
        { id: 'r1', cloud_provider: 'aws', service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
        { id: 'r2', cloud_provider: 'aws', service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 5 },
        { id: 'r3', cloud_provider: 'azure', service_name: 'Azure App Service', usage_date: '2026-07-01', cost: 8 },
      ],
    });

    render(<CompareTab companyId="company-1" />);

    expect(await screen.findByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('$8.00')).toBeInTheDocument();
    expect(screen.getByText('AWS')).toBeInTheDocument();
    expect(screen.getByText('Azure')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/reports/CompareTab.test.tsx`
Expected: FAIL — `Cannot find module './CompareTab'`.

- [ ] **Step 3: Write the component**

`components/reports/CompareTab.tsx`:
```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { CostRecord } from '@/lib/types';
import { totalCost } from '@/lib/reportAggregation';
import { computeDateRange, shiftReferenceDate, type Granularity } from '@/lib/dateRange';
import DateRangePicker from './DateRangePicker';
import styles from './CompareTab.module.css';

interface CompareTabProps {
  companyId: string;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function CompareTab({ companyId }: CompareTabProps) {
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
  }, [companyId, range.start, range.end]);

  const awsRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'aws'), [records]);
  const azureRecords = useMemo(() => records.filter((r) => r.cloud_provider === 'azure'), [records]);
  const awsTotal = useMemo(() => totalCost(awsRecords), [awsRecords]);
  const azureTotal = useMemo(() => totalCost(azureRecords), [azureRecords]);

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
      )}
    </div>
  );
}
```

`components/reports/CompareTab.module.css`:
```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.cards {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.card {
  background: var(--color-bg-alt);
  border-radius: 8px;
  padding: 1.5rem;
  flex: 1;
  min-width: 12rem;
}

.card h3 {
  margin: 0 0 0.5rem;
  color: var(--color-muted);
}

.total {
  font-size: 2rem;
  font-weight: 800;
  margin: 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest components/reports/CompareTab.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add components/reports/CompareTab.tsx components/reports/CompareTab.module.css components/reports/CompareTab.test.tsx
git commit -m "Add AWS vs Azure comparison tab"
```

---

## Task 2: Wire Azure and Compare tabs into the app shell

**Files:**
- Modify: `components/shell/AppShell.tsx`
- Modify: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `CostReportTab` (existing, called a second time with `cloudProvider="azure"` — zero changes to that component), `CompareTab` from `./../reports/CompareTab` (Task 1 of this phase).
- Produces: no new exports — `AppShell`'s existing props/signature (`{ userId: string; role: ProfileRole; companyId: string | null }`) are unchanged. Phase 3 modifies this same file again to add the Notes & Follow-ups and Admin tabs — keep the tab-list/panel-switch pattern consistent so that's a small diff too.

- [ ] **Step 1: Read the current `AppShell.tsx` and its test**

Before editing, read both files in full to see the exact current tab list (`aws`, `files`) and the `TabKey` union type, so the additions below slot in without disturbing the existing AWS/Uploaded Files behavior.

- [ ] **Step 2: Extend the failing test first**

Add these two tests to `components/shell/AppShell.test.tsx` (in addition to the existing four — do not remove or rewrite the existing tests, only add to the same `describe` block and mock setup):

```tsx
jest.mock('./../reports/CompareTab', () => ({
  __esModule: true,
  default: () => <div>compare-tab-content</div>,
}));
```
(add this alongside the existing `jest.mock` calls at the top of the file)

```tsx
  it('shows the Azure tab and the Compare tab, and switches to each', async () => {
    const user = userEvent.setup();
    render(<AppShell userId="client-1" role="client" companyId="c1" />);

    await user.click(screen.getByRole('tab', { name: /azure/i }));
    expect(screen.getByText('report-tab-content for azure')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /compare/i }));
    expect(screen.getByText('compare-tab-content')).toBeInTheDocument();
  });
```
(add this as a fifth `it(...)` inside the existing `describe('AppShell', ...)` block)

- [ ] **Step 3: Run the tests to verify the new one fails**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: the four pre-existing tests still PASS; the new test FAILS because there's no `tab` named "Azure" or "Compare" yet.

- [ ] **Step 4: Extend `AppShell.tsx`**

Modify the `TabKey` type, the tab-button list, and the panel-switch block. The rest of the file (top bar, company switcher, sign-out) is unchanged.

Change:
```tsx
type TabKey = 'aws' | 'files';
```
to:
```tsx
type TabKey = 'aws' | 'azure' | 'compare' | 'files';
```

Add the import alongside the existing `CostReportTab` import:
```tsx
import CompareTab from '../reports/CompareTab';
```

In the `role="tablist"` block, add two more tab buttons directly after the existing "AWS" button and before "Uploaded Files":
```tsx
        <button type="button" role="tab" aria-selected={activeTab === 'azure'} onClick={() => setActiveTab('azure')}>
          Azure
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'compare'} onClick={() => setActiveTab('compare')}>
          Compare
        </button>
```

In the panel-switch block, add two more conditions alongside the existing `activeTab === 'aws'` and `activeTab === 'files'` branches:
```tsx
            {activeTab === 'azure' && <CostReportTab companyId={effectiveCompanyId} cloudProvider="azure" />}
            {activeTab === 'compare' && <CompareTab companyId={effectiveCompanyId} />}
```

- [ ] **Step 5: Run the tests to verify they all pass**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: PASS (6 tests total — the original 4 plus the 2 new assertions folded into 1 new test... confirm the exact count matches what's in the file after Step 2).

- [ ] **Step 6: Verify the full pipeline**

Run: `npx tsc --noEmit` — expect no errors.
Run: `npm test` — expect all tests passing (Phase 1's full suite plus this phase's new tests).
Run: `npm run lint` — expect no errors.
Run: `npm run build` — expect a successful production build.

- [ ] **Step 7: Commit**

```bash
git add components/shell/AppShell.tsx components/shell/AppShell.test.tsx
git commit -m "Add Azure and Compare tabs to the app shell"
```

---

## Task 3: Manual verification and deployment

**Files:** none (verification and deployment only).

- [ ] **Step 1: Manual end-to-end pass on the local dev server**

Run `npm run dev`. Using the same staff/client test accounts and test company created during Phase 1's verification (Phase 1 plan, Task 12, Step 2):

1. Sign in as staff, select the test company.
2. Upload a real (or realistic synthetic) Azure Cost Management export via the existing upload flow (Uploaded Files tab — already supports selecting "Azure" as the cloud provider from Phase 1).
3. Confirm Uploaded Files shows it as `processed` with a row count.
4. Click the new Azure tab — confirm total, chart, and per-service table populate correctly from the Azure data.
5. Click the Compare tab — confirm it shows the AWS total (from Phase 1's uploaded AWS data) and the Azure total (from this file) side by side, and that the numbers match what each individual tab shows for the same date range.
6. Change the date-range granularity (day/week/month) and navigate prev/next on the Compare tab — confirm both totals update together.
7. Sign in as the test client account — confirm they see the same Azure and Compare tabs with the same data (no company switcher).

If anything fails, fix it and re-run the affected steps before deploying.

- [ ] **Step 2: Deploy**

Push the branch and confirm the production Vercel deployment builds successfully. Re-run the Step 1 verification pass against the production URL using the same test accounts.
