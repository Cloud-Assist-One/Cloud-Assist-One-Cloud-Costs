# Multi-Cloud Credentials Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the AWS-only, one-credential-per-company model into a multi-account, 4-provider (AWS/Azure/GCP/Snowflake) credentials system, with a reworked Settings UI and an account picker on the existing AWS Resources/IAM Users tabs.

**Architecture:** One `cloud_provider_credentials` table (already exists for AWS) gains a `label` (so multiple named connections per provider are allowed) and an `auth_type` column (prepping for a v2 cross-account role type, unused for now). Each provider gets its own credentials API route (field shapes differ too much to share one generic route), but the Settings UI list/add/delete UI is one generic `ConnectionsPanel` component reused by 4 thin per-provider wrappers. AWS's existing Resources/IAM Users tabs gain an account-picker `<select>` that re-fetches when switched.

**Tech Stack:** Next.js App Router API routes, Supabase (Postgres + service-role admin client), React 19, existing `lib/cloudCredentialsCrypto.ts` (AES-256-GCM, unchanged), Jest + React Testing Library.

**Spec:** docs/superpowers/specs/2026-08-24-multi-cloud-credentials-and-resources-design.md

## Global Constraints

- No new npm dependencies in this plan — Azure/GCP/Snowflake SDKs are needed only for sub-projects 2-4 (their resource dashboards), not for saving credentials.
- RLS convention: every table change keeps `cloud_provider_credentials` service-role-only (no client-facing policies) — this migration only adds columns/indexes, it does not touch RLS.
- No API route in this codebase has Jest coverage (established convention) — routes are verified live in the browser at the end, not with route-level unit tests. Component tests (Settings panels, AwsResourcesTab, AwsIamUsersTab) do get Jest coverage.
- Every existing test that currently passes must still pass after each task; do not leave a task "done" with a red test suite.
- Run `npm test`, `npx tsc --noEmit`, and `npm run lint` after every task before moving on.

---

### Task 1: Migration — multi-account schema

**Files:**
- Create: `supabase/migrations/20260826000000_cloud_provider_credentials_multi_account.sql`

**Interfaces:**
- Produces: `cloud_provider_credentials.label` (text, not null, default `'Default'`), `cloud_provider_credentials.auth_type` (text, not null, default `'keys'`, check constraint `in ('keys', 'role')`), and a new unique index on `(company_id, provider, label)` replacing the old `(company_id, provider)` one. Every later task's INSERT/SELECT statements rely on these two columns existing.

- [ ] **Step 1: Write the migration file**

```sql
-- Generalizes cloud_provider_credentials from "one row per (company, provider)"
-- to "many labeled connections per (company, provider)" so a company can
-- monitor multiple accounts per cloud provider. Also adds auth_type so a
-- future v2 cross-account IAM role connection type is additive later, not
-- a schema rewrite -- encrypted_payload stays one opaque blob either way.

alter table public.cloud_provider_credentials
  add column label text not null default 'Default',
  add column auth_type text not null default 'keys' check (auth_type in ('keys', 'role'));

drop index public.cloud_provider_credentials_company_provider_idx;

create unique index cloud_provider_credentials_company_provider_label_idx
  on public.cloud_provider_credentials (company_id, provider, label);
```

- [ ] **Step 2: Apply the migration to the live Supabase project**

Use the `mcp__supabase__apply_migration` tool with `project_id: vainlusneaasbvfvayqy`, `name: cloud_provider_credentials_multi_account`, and the SQL from Step 1 as `query`. This project applies migrations directly via the Supabase MCP tools rather than a local Supabase CLI stack (see how the original `cloud_provider_credentials` table itself was created).

- [ ] **Step 3: Verify the migration applied correctly**

Run via `mcp__supabase__execute_sql` (`project_id: vainlusneaasbvfvayqy`):

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'cloud_provider_credentials'
order by ordinal_position;
```

Expected: `label` and `auth_type` columns present with the defaults above. Then confirm any existing AWS row backfilled correctly:

```sql
select id, provider, label, auth_type from public.cloud_provider_credentials;
```

Expected: every existing row shows `label = 'Default'`, `auth_type = 'keys'`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260826000000_cloud_provider_credentials_multi_account.sql
git commit -m "Add label/auth_type to cloud_provider_credentials for multi-account support"
```

---

### Task 2: Shared types

**Files:**
- Modify: `lib/types.ts:93-102` (existing `CloudProviderCredentials` interface)

**Interfaces:**
- Consumes: Task 1's new `label`/`auth_type` columns.
- Produces: `CloudProviderCredentials` (updated), `AwsCredentialSummary`, `AzureCredentialSummary`, `GcpCredentialSummary`, `SnowflakeCredentialSummary` — every later API route and component imports these exact names/shapes.

- [ ] **Step 1: Replace the `CloudProviderCredentials` interface and add the 4 summary types**

Replace lines 93-102 (the current `CloudProviderCredentials` interface) with:

```ts
export interface CloudProviderCredentials {
  id: string;
  company_id: string;
  provider: CloudProvider;
  label: string;
  auth_type: 'keys' | 'role';
  region: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AwsCredentialSummary {
  id: string;
  label: string;
  accessKeyIdMasked: string;
  region: string;
}

export interface AzureCredentialSummary {
  id: string;
  label: string;
  tenantId: string;
  clientId: string;
  subscriptionId: string;
}

export interface GcpCredentialSummary {
  id: string;
  label: string;
  projectId: string;
}

export interface SnowflakeCredentialSummary {
  id: string;
  label: string;
  account: string;
  username: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no other file in the codebase imports `CloudProviderCredentials` yet (verify with a search for that name if unsure), so widening its `metadata` field and adding `label`/`auth_type` doesn't break anything else. The 4 new summary types aren't consumed until later tasks.

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "Add multi-account credential summary types for all 4 providers"
```

---

### Task 3: Rework the AWS credentials API route for multiple connections

**Files:**
- Modify: `app/api/settings/aws-credentials/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `AwsCredentialSummary` (Task 2), `requireCompanyAccess` (`lib/admin-guard.ts`, unchanged), `createAdminClient` (`lib/supabase/admin.ts`, unchanged), `encryptCredentials` (`lib/cloudCredentialsCrypto.ts`, unchanged).
- Produces: `GET ?companyId=` → `{ connections: AwsCredentialSummary[] }`. `POST` body `{ companyId, label, accessKeyId, secretAccessKey, region }` → `{ connection: AwsCredentialSummary }`. `DELETE ?companyId=&id=` → `{ deleted: true }`. Tasks 9 and 11 call this route with this exact shape.

- [ ] **Step 1: Replace the file's full contents**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AwsCredentialSummary } from '@/lib/types';

const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;

function maskAccessKeyId(accessKeyId: string): string {
  if (accessKeyId.length <= 8) return accessKeyId;
  return `${accessKeyId.slice(0, 4)}${'*'.repeat(accessKeyId.length - 8)}${accessKeyId.slice(-4)}`;
}

function toSummary(row: { id: string; label: string; region: string | null; metadata: Record<string, unknown> }): AwsCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    accessKeyIdMasked: (row.metadata?.accessKeyIdMasked as string | undefined) ?? '',
    region: row.region ?? '',
  };
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
    .from('cloud_provider_credentials')
    .select('id, label, region, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up AWS credentials:', error);
    return NextResponse.json({ error: 'Could not look up the AWS connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, accessKeyId, secretAccessKey, region } = body as {
    companyId?: string;
    label?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof accessKeyId !== 'string' ||
    !accessKeyId.trim() ||
    typeof secretAccessKey !== 'string' ||
    !secretAccessKey.trim() ||
    typeof region !== 'string' ||
    !region.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, accessKeyId, secretAccessKey, and region are all required.' },
      { status: 400 }
    );
  }
  if (!REGION_PATTERN.test(region)) {
    return NextResponse.json({ error: 'region must look like an AWS region, e.g. us-east-1.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const accessKeyIdMasked = maskAccessKeyId(accessKeyId);
  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ accessKeyId, secretAccessKey });
  } catch (err) {
    console.error('Failed to encrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not save the AWS connection.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'aws',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      region,
      metadata: { accessKeyIdMasked },
      created_by: guard.userId,
    })
    .select('id, label, region, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `An AWS connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const id = request.nextUrl.searchParams.get('id');
  if (!companyId || !id) {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from('cloud_provider_credentials')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: this file's errors are gone; remaining errors (if any) are in `components/settings/SettingsTab.tsx`, fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add app/api/settings/aws-credentials/route.ts
git commit -m "Rework the AWS credentials route to support multiple labeled connections"
```

---

### Task 4: Add Azure/GCP/Snowflake credentials API routes

**Files:**
- Create: `app/api/settings/azure-credentials/route.ts`
- Create: `app/api/settings/gcp-credentials/route.ts`
- Create: `app/api/settings/snowflake-credentials/route.ts`

**Interfaces:**
- Consumes: `AzureCredentialSummary`, `GcpCredentialSummary`, `SnowflakeCredentialSummary` (Task 2); `requireCompanyAccess`, `createAdminClient`, `encryptCredentials` (unchanged).
- Produces: same `GET`/`POST`/`DELETE` shape as Task 3's AWS route, one per provider. Task 7's per-provider panel components call these exact paths and body shapes.

- [ ] **Step 1: Create `app/api/settings/azure-credentials/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AzureCredentialSummary } from '@/lib/types';

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): AzureCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    tenantId: (row.metadata?.tenantId as string | undefined) ?? '',
    clientId: (row.metadata?.clientId as string | undefined) ?? '',
    subscriptionId: (row.metadata?.subscriptionId as string | undefined) ?? '',
  };
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
    .from('cloud_provider_credentials')
    .select('id, label, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up Azure credentials:', error);
    return NextResponse.json({ error: 'Could not look up the Azure connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, tenantId, clientId, clientSecret, subscriptionId } = body as {
    companyId?: string;
    label?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    subscriptionId?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof tenantId !== 'string' ||
    !tenantId.trim() ||
    typeof clientId !== 'string' ||
    !clientId.trim() ||
    typeof clientSecret !== 'string' ||
    !clientSecret.trim() ||
    typeof subscriptionId !== 'string' ||
    !subscriptionId.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, tenantId, clientId, clientSecret, and subscriptionId are all required.' },
      { status: 400 }
    );
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ tenantId, clientId, clientSecret, subscriptionId });
  } catch (err) {
    console.error('Failed to encrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not save the Azure connection.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'azure',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      metadata: { tenantId, clientId, subscriptionId },
      created_by: guard.userId,
    })
    .select('id, label, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `An Azure connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const id = request.nextUrl.searchParams.get('id');
  if (!companyId || !id) {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from('cloud_provider_credentials')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 2: Create `app/api/settings/gcp-credentials/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { GcpCredentialSummary } from '@/lib/types';

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): GcpCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    projectId: (row.metadata?.projectId as string | undefined) ?? '',
  };
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
    .from('cloud_provider_credentials')
    .select('id, label, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'gcp')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up GCP credentials:', error);
    return NextResponse.json({ error: 'Could not look up the GCP connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, projectId, serviceAccountJson } = body as {
    companyId?: string;
    label?: string;
    projectId?: string;
    serviceAccountJson?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof projectId !== 'string' ||
    !projectId.trim() ||
    typeof serviceAccountJson !== 'string' ||
    !serviceAccountJson.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, projectId, and serviceAccountJson are all required.' },
      { status: 400 }
    );
  }

  try {
    JSON.parse(serviceAccountJson);
  } catch {
    return NextResponse.json({ error: 'serviceAccountJson must be valid JSON.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ projectId, serviceAccountJson });
  } catch (err) {
    console.error('Failed to encrypt GCP credentials:', err);
    return NextResponse.json({ error: 'Could not save the GCP connection.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'gcp',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      metadata: { projectId },
      created_by: guard.userId,
    })
    .select('id, label, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A GCP connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const id = request.nextUrl.searchParams.get('id');
  if (!companyId || !id) {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from('cloud_provider_credentials')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', 'gcp')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 3: Create `app/api/settings/snowflake-credentials/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { SnowflakeCredentialSummary } from '@/lib/types';

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): SnowflakeCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    account: (row.metadata?.account as string | undefined) ?? '',
    username: (row.metadata?.username as string | undefined) ?? '',
  };
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
    .from('cloud_provider_credentials')
    .select('id, label, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'snowflake')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up Snowflake credentials:', error);
    return NextResponse.json({ error: 'Could not look up the Snowflake connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, account, username, password } = body as {
    companyId?: string;
    label?: string;
    account?: string;
    username?: string;
    password?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof account !== 'string' ||
    !account.trim() ||
    typeof username !== 'string' ||
    !username.trim() ||
    typeof password !== 'string' ||
    !password.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, account, username, and password are all required.' },
      { status: 400 }
    );
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ account, username, password });
  } catch (err) {
    console.error('Failed to encrypt Snowflake credentials:', err);
    return NextResponse.json({ error: 'Could not save the Snowflake connection.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'snowflake',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      metadata: { account, username },
      created_by: guard.userId,
    })
    .select('id, label, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A Snowflake connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const id = request.nextUrl.searchParams.get('id');
  if (!companyId || !id) {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from('cloud_provider_credentials')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', 'snowflake')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors from these 3 new files.

- [ ] **Step 5: Commit**

```bash
git add app/api/settings/azure-credentials/route.ts app/api/settings/gcp-credentials/route.ts app/api/settings/snowflake-credentials/route.ts
git commit -m "Add Azure/GCP/Snowflake credentials API routes"
```

---

### Task 5: Require `credentialId` on the AWS resource-fetch routes

**Files:**
- Modify: `app/api/aws/resources/route.ts:36-53`
- Modify: `app/api/aws/iam-users/route.ts:13-35`

**Interfaces:**
- Consumes: nothing new.
- Produces: both routes now require `?credentialId=` in addition to `?companyId=`. Tasks 9 and 10 call both routes with this param.

- [ ] **Step 1: Update `app/aws/resources/route.ts`'s `GET` credential lookup**

Replace:

```ts
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
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .maybeSingle();
```

with:

```ts
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  if (!companyId || !credentialId) {
    return NextResponse.json({ error: 'companyId and credentialId are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();
```

The rest of the file (decrypt, fetch 7 services, build the response) is unchanged.

- [ ] **Step 2: Update `app/api/aws/iam-users/route.ts`'s `GET` credential lookup**

Replace:

```ts
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
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .maybeSingle();
```

with:

```ts
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  if (!companyId || !credentialId) {
    return NextResponse.json({ error: 'companyId and credentialId are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();
```

The rest of the file (decrypt, list users) is unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/aws/resources/route.ts app/api/aws/iam-users/route.ts
git commit -m "Require credentialId on the AWS resource-fetch routes"
```

---

### Task 6: Generic `ConnectionsPanel` component

**Files:**
- Create: `components/settings/ConnectionsPanel.tsx`
- Create: `components/settings/ConnectionsPanel.module.css`
- Test: `components/settings/ConnectionsPanel.test.tsx`

**Interfaces:**
- Consumes: nothing project-specific (pure list/add/delete UI driven entirely by its props).
- Produces: `ConnectionsPanel<TSummary extends { id: string; label: string }>` React component with props `{ companyId: string; apiPath: string; fields: ConnectionField[]; renderSummary: (connection: TSummary) => string }`, and the exported `ConnectionField` type (`{ name: string; label: string; type: 'text' | 'password' | 'textarea'; defaultValue?: string }`). Task 7's 4 provider panels are thin wrappers around this component.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionsPanel from './ConnectionsPanel';

interface TestSummary {
  id: string;
  label: string;
  value: string;
}

describe('ConnectionsPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows "no connections yet" when the list is empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
  });

  it('lists existing connections with their summary', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
    });

    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText(/value abc/)).toBeInTheDocument();
  });

  it('adds a new connection', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connection: { id: 'c1', label: 'Production', value: 'abc' } }),
      });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/^label$/i), 'Production');
    await user.type(screen.getByLabelText(/^value$/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/test-credentials',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByText('Production')).toBeInTheDocument();
  });

  it('disconnects after confirmation', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connections: [{ id: 'c1', label: 'Production', value: 'abc' }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText('Production');
    await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
    await user.click(screen.getByRole('button', { name: /confirm disconnect/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/settings/test-credentials?companyId=company-1&id=c1',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
    expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
  });

  it('surfaces an error if saving fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'label is required.' }) });

    const user = userEvent.setup();
    render(
      <ConnectionsPanel<TestSummary>
        companyId="company-1"
        apiPath="/api/settings/test-credentials"
        fields={[{ name: 'value', label: 'Value', type: 'text' }]}
        renderSummary={(c) => `value ${c.value}`}
      />
    );

    await screen.findByText(/no connections yet/i);
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    await user.type(screen.getByLabelText(/^value$/i), 'abc');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/label is required/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ConnectionsPanel`
Expected: FAIL — `Cannot find module './ConnectionsPanel'`.

- [ ] **Step 3: Write `components/settings/ConnectionsPanel.module.css`**

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 32rem;
}

.error {
  color: #d1274b;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.connectionCard {
  background: var(--color-bg-alt);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.form label {
  font-weight: 600;
}

.fieldRow {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.form input,
.form textarea {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}

.form textarea {
  min-height: 6rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.85rem;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.actions button,
.addButton {
  padding: 0.5rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  color: #fff;
  cursor: pointer;
  font: inherit;
}

.addButton {
  align-self: flex-start;
}

.actions button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dangerButton {
  background: none !important;
  color: var(--muted-foreground) !important;
  border: 1px solid var(--color-border) !important;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font: inherit;
}

.dangerButton:hover:not(:disabled) {
  color: #b3261e !important;
}

.confirmDisconnect {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
```

- [ ] **Step 4: Write `components/settings/ConnectionsPanel.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './ConnectionsPanel.module.css';

export interface ConnectionField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea';
  defaultValue?: string;
}

interface ConnectionsPanelProps<TSummary extends { id: string; label: string }> {
  companyId: string;
  apiPath: string;
  fields: ConnectionField[];
  renderSummary: (connection: TSummary) => string;
}

export default function ConnectionsPanel<TSummary extends { id: string; label: string }>({
  companyId,
  apiPath,
  fields,
  renderSummary,
}: ConnectionsPanelProps<TSummary>) {
  const [connections, setConnections] = useState<TSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? '']))
  );
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const response = await fetch(`${apiPath}?companyId=${companyId}`);
    const body = await response.json();
    return (body.connections ?? []) as TSummary[];
  }, [apiPath, companyId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const result = await loadConnections();
      if (!cancelled) {
        setConnections(result);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [loadConnections]);

  async function handleAdd() {
    setError(null);
    setSaving(true);
    const response = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, label, ...values }),
    });
    const body = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(body.error ?? 'Could not save the connection.');
      return;
    }
    setConnections((prev) => [...(prev ?? []), body.connection as TSummary]);
    setAdding(false);
    setLabel('');
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ''])));
  }

  async function handleDelete(id: string) {
    setError(null);
    setDeletingId(id);
    const response = await fetch(`${apiPath}?companyId=${companyId}&id=${id}`, { method: 'DELETE' });
    const body = await response.json();
    setDeletingId(null);
    if (!response.ok) {
      setError(body.error ?? 'Could not disconnect.');
      return;
    }
    setConnections((prev) => (prev ?? []).filter((c) => c.id !== id));
    setConfirmingDeleteId(null);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  return (
    <div className={styles.wrapper}>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {connections && connections.length > 0 && (
        <ul className={styles.list}>
          {connections.map((connection) => (
            <li key={connection.id} className={styles.connectionCard}>
              <div>
                <strong>{connection.label}</strong> — {renderSummary(connection)}
              </div>
              {confirmingDeleteId === connection.id ? (
                <span className={styles.confirmDisconnect}>
                  <span>Disconnect this connection?</span>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={deletingId === connection.id}
                    onClick={() => handleDelete(connection.id)}
                  >
                    {deletingId === connection.id ? 'Disconnecting…' : 'Confirm disconnect'}
                  </button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => setConfirmingDeleteId(connection.id)}
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {connections && connections.length === 0 && !adding && <p>No connections yet.</p>}

      {adding ? (
        <div className={styles.form}>
          <label htmlFor="connection-label">Label</label>
          <input id="connection-label" value={label} onChange={(e) => setLabel(e.target.value)} />

          {fields.map((field) => (
            <div key={field.name} className={styles.fieldRow}>
              <label htmlFor={`connection-field-${field.name}`}>{field.label}</label>
              {field.type === 'textarea' ? (
                <textarea
                  id={`connection-field-${field.name}`}
                  value={values[field.name]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                />
              ) : (
                <input
                  id={`connection-field-${field.name}`}
                  type={field.type}
                  value={values[field.name]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                />
              )}
            </div>
          ))}

          <div className={styles.actions}>
            <button type="button" disabled={saving} onClick={handleAdd}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addButton} onClick={() => setAdding(true)}>
          Add connection
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- ConnectionsPanel`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add components/settings/ConnectionsPanel.tsx components/settings/ConnectionsPanel.module.css components/settings/ConnectionsPanel.test.tsx
git commit -m "Add a generic ConnectionsPanel for multi-account credential management"
```

---

### Task 7: The 4 provider credential panels

**Files:**
- Create: `components/settings/AwsCredentialsPanel.tsx`
- Create: `components/settings/AzureCredentialsPanel.tsx`
- Create: `components/settings/GcpCredentialsPanel.tsx`
- Create: `components/settings/SnowflakeCredentialsPanel.tsx`
- Test: `components/settings/CredentialsPanels.test.tsx`

**Interfaces:**
- Consumes: `ConnectionsPanel`, `ConnectionField` (Task 6); `AwsCredentialSummary`, `AzureCredentialSummary`, `GcpCredentialSummary`, `SnowflakeCredentialSummary` (Task 2).
- Produces: `AwsCredentialsPanel`, `AzureCredentialsPanel`, `GcpCredentialsPanel`, `SnowflakeCredentialsPanel` — each `{ companyId: string }` → JSX.Element. Task 8's `SettingsTab` imports all 4.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsCredentialsPanel from './AwsCredentialsPanel';
import AzureCredentialsPanel from './AzureCredentialsPanel';
import GcpCredentialsPanel from './GcpCredentialsPanel';
import SnowflakeCredentialsPanel from './SnowflakeCredentialsPanel';

describe('provider credentials panels', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });
  });

  it('AWS panel fetches from the AWS endpoint and shows AWS fields', async () => {
    const user = userEvent.setup();
    render(<AwsCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/aws-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/access key id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secret access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^region$/i)).toBeInTheDocument();
  });

  it('Azure panel fetches from the Azure endpoint and shows Azure fields', async () => {
    const user = userEvent.setup();
    render(<AzureCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/azure-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/tenant id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^client id$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/subscription id/i)).toBeInTheDocument();
  });

  it('GCP panel fetches from the GCP endpoint and shows GCP fields', async () => {
    const user = userEvent.setup();
    render(<GcpCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/gcp-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/project id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/service account json key/i)).toBeInTheDocument();
  });

  it('Snowflake panel fetches from the Snowflake endpoint and shows Snowflake fields', async () => {
    const user = userEvent.setup();
    render(<SnowflakeCredentialsPanel companyId="company-1" />);

    await screen.findByText(/no connections yet/i);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/snowflake-credentials?companyId=company-1');
    await user.click(screen.getByRole('button', { name: /add connection/i }));
    expect(screen.getByLabelText(/account identifier/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- CredentialsPanels`
Expected: FAIL — `Cannot find module './AwsCredentialsPanel'`.

- [ ] **Step 3: Write `components/settings/AwsCredentialsPanel.tsx`**

```tsx
'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AwsCredentialSummary } from '@/lib/types';

export default function AwsCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<AwsCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/aws-credentials"
      fields={[
        { name: 'accessKeyId', label: 'Access key ID', type: 'text' },
        { name: 'secretAccessKey', label: 'Secret access key', type: 'password' },
        { name: 'region', label: 'Region', type: 'text', defaultValue: 'us-east-1' },
      ]}
      renderSummary={(c) => `Access key ${c.accessKeyIdMasked}, region ${c.region}`}
    />
  );
}
```

- [ ] **Step 4: Write `components/settings/AzureCredentialsPanel.tsx`**

```tsx
'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { AzureCredentialSummary } from '@/lib/types';

export default function AzureCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<AzureCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/azure-credentials"
      fields={[
        { name: 'tenantId', label: 'Tenant ID', type: 'text' },
        { name: 'clientId', label: 'Client ID', type: 'text' },
        { name: 'clientSecret', label: 'Client secret', type: 'password' },
        { name: 'subscriptionId', label: 'Subscription ID', type: 'text' },
      ]}
      renderSummary={(c) => `Subscription ${c.subscriptionId}, client ${c.clientId}`}
    />
  );
}
```

- [ ] **Step 5: Write `components/settings/GcpCredentialsPanel.tsx`**

```tsx
'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { GcpCredentialSummary } from '@/lib/types';

export default function GcpCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<GcpCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/gcp-credentials"
      fields={[
        { name: 'projectId', label: 'Project ID', type: 'text' },
        { name: 'serviceAccountJson', label: 'Service account JSON key', type: 'textarea' },
      ]}
      renderSummary={(c) => `Project ${c.projectId}`}
    />
  );
}
```

- [ ] **Step 6: Write `components/settings/SnowflakeCredentialsPanel.tsx`**

```tsx
'use client';

import ConnectionsPanel from './ConnectionsPanel';
import type { SnowflakeCredentialSummary } from '@/lib/types';

export default function SnowflakeCredentialsPanel({ companyId }: { companyId: string }) {
  return (
    <ConnectionsPanel<SnowflakeCredentialSummary>
      companyId={companyId}
      apiPath="/api/settings/snowflake-credentials"
      fields={[
        { name: 'account', label: 'Account identifier', type: 'text' },
        { name: 'username', label: 'Username', type: 'text' },
        { name: 'password', label: 'Password', type: 'password' },
      ]}
      renderSummary={(c) => `Account ${c.account}, user ${c.username}`}
    />
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- CredentialsPanels`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add components/settings/AwsCredentialsPanel.tsx components/settings/AzureCredentialsPanel.tsx components/settings/GcpCredentialsPanel.tsx components/settings/SnowflakeCredentialsPanel.tsx components/settings/CredentialsPanels.test.tsx
git commit -m "Add per-provider credential panels for AWS/Azure/GCP/Snowflake"
```

---

### Task 8: Rework `SettingsTab` into a 4-provider sub-tab strip

**Files:**
- Modify: `components/settings/SettingsTab.tsx` (full rewrite)
- Modify: `components/settings/SettingsTab.module.css` (full rewrite)
- Modify: `components/settings/SettingsTab.test.tsx` (full rewrite — the old singleton-AWS-form tests no longer apply)

**Interfaces:**
- Consumes: `AwsCredentialsPanel`, `AzureCredentialsPanel`, `GcpCredentialsPanel`, `SnowflakeCredentialsPanel` (Task 7); `Tabs`/`TabsList`/`TabsTrigger` (`components/ui/tabs.tsx`, unchanged); `CLOUD_PROVIDERS`/`CLOUD_PROVIDER_LABELS` (`lib/cloudProvider.ts`, unchanged); `CloudProvider` (`lib/types.ts`, unchanged).
- Produces: `SettingsTab({ companyId: string })` — unchanged external prop signature, so `AppShell.tsx` needs no changes.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsTab from './SettingsTab';

jest.mock('./AwsCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>aws-credentials-panel</div>,
}));
jest.mock('./AzureCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>azure-credentials-panel</div>,
}));
jest.mock('./GcpCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>gcp-credentials-panel</div>,
}));
jest.mock('./SnowflakeCredentialsPanel', () => ({
  __esModule: true,
  default: () => <div>snowflake-credentials-panel</div>,
}));

describe('SettingsTab', () => {
  it('defaults to the AWS panel', async () => {
    render(<SettingsTab companyId="company-1" />);

    expect(await screen.findByText('aws-credentials-panel')).toBeInTheDocument();
  });

  it('switches to the Azure panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /microsoft azure/i }));
    expect(await screen.findByText('azure-credentials-panel')).toBeInTheDocument();
    expect(screen.queryByText('aws-credentials-panel')).not.toBeInTheDocument();
  });

  it('switches to the GCP panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /google cloud/i }));
    expect(await screen.findByText('gcp-credentials-panel')).toBeInTheDocument();
  });

  it('switches to the Snowflake panel', async () => {
    const user = userEvent.setup();
    render(<SettingsTab companyId="company-1" />);

    await screen.findByText('aws-credentials-panel');
    await user.click(screen.getByRole('tab', { name: /snowflake/i }));
    expect(await screen.findByText('snowflake-credentials-panel')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- SettingsTab`
Expected: FAIL — the old `SettingsTab` renders a raw AWS form, not the mocked panel text, so `findByText('aws-credentials-panel')` times out.

- [ ] **Step 3: Replace `components/settings/SettingsTab.module.css`**

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
```

- [ ] **Step 4: Replace `components/settings/SettingsTab.tsx`**

```tsx
'use client';

import { useState, type ComponentType } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';
import AwsCredentialsPanel from './AwsCredentialsPanel';
import AzureCredentialsPanel from './AzureCredentialsPanel';
import GcpCredentialsPanel from './GcpCredentialsPanel';
import SnowflakeCredentialsPanel from './SnowflakeCredentialsPanel';
import styles from './SettingsTab.module.css';

interface SettingsTabProps {
  companyId: string;
}

const PANELS: Record<CloudProvider, ComponentType<{ companyId: string }>> = {
  aws: AwsCredentialsPanel,
  azure: AzureCredentialsPanel,
  gcp: GcpCredentialsPanel,
  snowflake: SnowflakeCredentialsPanel,
};

export default function SettingsTab({ companyId }: SettingsTabProps) {
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const ActivePanel = PANELS[provider];

  return (
    <div className={styles.wrapper}>
      <Tabs value={provider} onValueChange={(value) => setProvider(value as CloudProvider)}>
        <TabsList>
          {CLOUD_PROVIDERS.map((p) => (
            <TabsTrigger key={p} value={p}>
              {CLOUD_PROVIDER_LABELS[p]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <ActivePanel companyId={companyId} />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- SettingsTab`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add components/settings/SettingsTab.tsx components/settings/SettingsTab.module.css components/settings/SettingsTab.test.tsx
git commit -m "Rework SettingsTab into a 4-provider sub-tab strip"
```

---

### Task 9: Account picker on `AwsResourcesTab`

**Files:**
- Modify: `components/reports/AwsResourcesTab.tsx` (full rewrite)
- Modify: `components/reports/AwsResourcesTab.module.css` (add one rule)
- Modify: `components/reports/AwsResourcesTab.test.tsx` (full rewrite — every existing test needs an extra mocked fetch call for the connections list, plus a new account-switching test)

**Interfaces:**
- Consumes: `AwsCredentialSummary` (Task 2); `GET /api/settings/aws-credentials?companyId=` (Task 3); `GET /api/aws/resources?companyId=&credentialId=` (Task 5); `ResourceGrid`, `ResourceLegend` (`./ResourceGrid`, unchanged).
- Produces: unchanged external prop signature `AwsResourcesTab({ companyId: string })` — `AppShell.tsx` needs no changes.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsResourcesTab from './AwsResourcesTab';

const emptyResource = { data: [], error: null };
const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    region: 'us-east-1',
    fetchedAt: '2026-08-24T12:00:00.000Z',
    ec2: emptyResource,
    lambda: emptyResource,
    ecs: emptyResource,
    rds: emptyResource,
    dynamodb: emptyResource,
    apis: emptyResource,
    s3: emptyResource,
    ...overrides,
  };
}

describe('AwsResourcesTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved AWS connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders rows for each grid when data is present', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            ec2: {
              data: [
                {
                  instanceId: 'i-123',
                  name: 'web-1',
                  instanceType: 't3.micro',
                  state: 'running',
                  availabilityZone: 'us-east-1a',
                  privateIp: '10.0.0.1',
                  publicIp: null,
                  launchTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
            s3: { data: [{ name: 'my-bucket', creationDate: '2026-01-01T00:00:00.000Z' }], error: null },
          }),
      });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByText('i-123')).toBeInTheDocument();
    expect(screen.getByText('web-1')).toBeInTheDocument();
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
    expect(screen.getByText('No Lambda functions found.')).toBeInTheDocument();
  });

  it('shows a per-grid error without hiding other grids', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            ec2: { data: [], error: 'AccessDenied: not authorized to perform ec2:DescribeInstances' },
            s3: { data: [{ name: 'my-bucket', creationDate: null }], error: null },
          }),
      });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/accessdenied/i);
    expect(screen.getByText('my-bucket')).toBeInTheDocument();
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AwsResourcesTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
    expect(screen.getByText(/new in the last week/i)).toBeInTheDocument();
    expect(screen.getByText(/new in the last month/i)).toBeInTheDocument();
  });

  it('flags a recently-launched EC2 instance with the "orange" recent-age row class', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            ec2: {
              data: [
                {
                  instanceId: 'i-new',
                  name: null,
                  instanceType: 't3.micro',
                  state: 'running',
                  availabilityZone: null,
                  privateIp: null,
                  publicIp: null,
                  launchTime: '2026-08-24T06:00:00.000Z',
                },
                {
                  instanceId: 'i-old',
                  name: null,
                  instanceType: 't3.micro',
                  state: 'running',
                  availabilityZone: null,
                  privateIp: null,
                  publicIp: null,
                  launchTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AwsResourcesTab companyId="company-1" />);

    const newRow = await screen.findByText('i-new');
    const oldRow = await screen.findByText('i-old');
    expect(newRow.closest('tr')?.className).toMatch(/rowOrange/);
    expect(oldRow.closest('tr')?.className).toBeFalsy();

    jest.useRealTimers();
  });

  it('links the verify icon to a pre-filled mailto for that resource', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            ec2: {
              data: [
                {
                  instanceId: 'i-123',
                  name: 'web-1',
                  instanceType: 't3.micro',
                  state: 'running',
                  availabilityZone: 'us-east-1a',
                  privateIp: '10.0.0.1',
                  publicIp: null,
                  launchTime: '2026-01-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AwsResourcesTab companyId="company-1" />);

    await screen.findByText('i-123');
    const verifyLink = screen.getByRole('link', { name: /email to verify this ec2 instance, web-1/i });
    const href = decodeURIComponent(verifyLink.getAttribute('href') ?? '');
    expect(href).toContain('mailto:?subject=Verify AWS resource: EC2 instance web-1');
    expect(href).toContain('Please verify this EC2 instance "web-1" is valid and let me know what it is being used for.');
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AwsResourcesTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's resources", async () => {
    const twoConnections = {
      connections: [
        { id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' },
        { id: 'conn-2', label: 'Client sandbox', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2' },
      ],
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => twoConnections })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse({ region: 'us-east-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse({ region: 'us-west-2' }) });

    const user = userEvent.setup();
    render(<AwsResourcesTab companyId="company-1" />);

    await screen.findByText(/region us-east-1/i);
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/aws/resources?companyId=company-1&credentialId=conn-2')
    );
    expect(await screen.findByText(/region us-west-2/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- AwsResourcesTab`
Expected: FAIL — the current component fetches `/api/aws/resources?companyId=...` directly with no connections-list call first, so the mocked responses are consumed out of order and assertions fail.

- [ ] **Step 3: Add the account-picker CSS rule to `components/reports/AwsResourcesTab.module.css`**

Add (anywhere in the file, e.g. after `.header`):

```css
.accountPicker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.accountPicker select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}
```

- [ ] **Step 4: Replace `components/reports/AwsResourcesTab.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type {
  AwsCredentialSummary,
  AwsResourcesResponse,
  Ec2InstanceRow,
  LambdaFunctionRow,
  EcsServiceRow,
  RdsInstanceRow,
  DynamoTableRow,
  ApiRow,
  S3BucketRow,
} from '@/lib/types';
import styles from './AwsResourcesTab.module.css';

interface AwsResourcesTabProps {
  companyId: string;
}

export default function AwsResourcesTab({ companyId }: AwsResourcesTabProps) {
  const [connections, setConnections] = useState<AwsCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AwsResourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadResources = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/aws/resources?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load AWS resources.');
      }
      return body as AwsResourcesResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AwsCredentialSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadResources(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load AWS resources.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadResources]);

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadResources(id);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load AWS resources.');
    }
    setRefreshing(false);
  }

  async function handleRefresh() {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadResources(selectedId);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load AWS resources.');
    }
    setRefreshing(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return <p>AWS isn&apos;t connected yet. Add your AWS access key in the Settings tab to see live resources.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="aws-account-picker">Account</label>
          <select
            id="aws-account-picker"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectConnection(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>
          Region {response.region} — last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<Ec2InstanceRow>
        title="EC2 Instances"
        emptyLabel="No EC2 instances found."
        result={response.ec2}
        getCreatedAt={(r) => r.launchTime}
        getName={(r) => r.name ?? r.instanceId}
        resourceType="EC2 instance"
        columns={[
          { header: 'Instance ID', render: (r) => r.instanceId },
          { header: 'Name', render: (r) => r.name ?? '—' },
          { header: 'Type', render: (r) => r.instanceType },
          { header: 'State', render: (r) => r.state },
          { header: 'AZ', render: (r) => r.availabilityZone ?? '—' },
          { header: 'Private IP', render: (r) => r.privateIp ?? '—' },
          { header: 'Public IP', render: (r) => r.publicIp ?? '—' },
        ]}
      />

      <ResourceGrid<LambdaFunctionRow>
        title="Lambda Functions"
        emptyLabel="No Lambda functions found."
        result={response.lambda}
        getCreatedAt={(r) => r.lastModified}
        getName={(r) => r.functionName}
        resourceType="Lambda function"
        columns={[
          { header: 'Function name', render: (r) => r.functionName },
          { header: 'Runtime', render: (r) => r.runtime ?? '—' },
          { header: 'Memory (MB)', render: (r) => r.memorySize ?? '—', align: 'right' },
          { header: 'Timeout (s)', render: (r) => r.timeout ?? '—', align: 'right' },
          { header: 'Last modified', render: (r) => r.lastModified ?? '—' },
        ]}
      />

      <ResourceGrid<EcsServiceRow>
        title="ECS Containers"
        emptyLabel="No ECS services found."
        result={response.ecs}
        getCreatedAt={(r) => r.createdAt}
        getName={(r) => r.serviceName}
        resourceType="ECS service"
        columns={[
          { header: 'Cluster', render: (r) => r.cluster },
          { header: 'Service', render: (r) => r.serviceName },
          { header: 'Desired count', render: (r) => r.desiredCount, align: 'right' },
          { header: 'Running count', render: (r) => r.runningCount, align: 'right' },
          { header: 'Launch type', render: (r) => r.launchType ?? '—' },
        ]}
      />

      <ResourceGrid<RdsInstanceRow>
        title="RDS Instances"
        emptyLabel="No RDS instances found."
        result={response.rds}
        getCreatedAt={(r) => r.instanceCreateTime}
        getName={(r) => r.dbInstanceIdentifier}
        resourceType="RDS instance"
        columns={[
          { header: 'DB identifier', render: (r) => r.dbInstanceIdentifier },
          { header: 'Engine', render: (r) => r.engine },
          { header: 'Instance class', render: (r) => r.dbInstanceClass },
          { header: 'Status', render: (r) => r.status },
          { header: 'Multi-AZ', render: (r) => (r.multiAz ? 'Yes' : 'No') },
          { header: 'Storage (GB)', render: (r) => r.allocatedStorage, align: 'right' },
        ]}
      />

      <ResourceGrid<DynamoTableRow>
        title="DynamoDB Tables"
        emptyLabel="No DynamoDB tables found."
        result={response.dynamodb}
        getCreatedAt={(r) => r.creationDateTime}
        getName={(r) => r.tableName}
        resourceType="DynamoDB table"
        columns={[{ header: 'Table name', render: (r) => r.tableName }]}
      />

      <ResourceGrid<ApiRow>
        title="APIs"
        emptyLabel="No APIs found."
        result={response.apis}
        getCreatedAt={(r) => r.createdDate}
        getName={(r) => r.name}
        resourceType="API"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'ID', render: (r) => r.id },
          { header: 'Type', render: (r) => r.type },
          { header: 'Created', render: (r) => r.createdDate ?? '—' },
          { header: 'Endpoint', render: (r) => r.endpoint ?? '—' },
        ]}
      />

      <ResourceGrid<S3BucketRow>
        title="S3 Buckets"
        emptyLabel="No S3 buckets found."
        result={response.s3}
        getCreatedAt={(r) => r.creationDate}
        getName={(r) => r.name}
        resourceType="S3 bucket"
        columns={[
          { header: 'Bucket name', render: (r) => r.name },
          { header: 'Created', render: (r) => r.creationDate ?? '—' },
        ]}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- AwsResourcesTab`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add components/reports/AwsResourcesTab.tsx components/reports/AwsResourcesTab.module.css components/reports/AwsResourcesTab.test.tsx
git commit -m "Add a multi-account picker to AwsResourcesTab"
```

---

### Task 10: Account picker on `AwsIamUsersTab`

**Files:**
- Modify: `components/reports/AwsIamUsersTab.tsx` (full rewrite)
- Modify: `components/reports/AwsIamUsersTab.module.css` (add one rule)
- Modify: `components/reports/AwsIamUsersTab.test.tsx` (full rewrite — same reason as Task 9)

**Interfaces:**
- Consumes: `AwsCredentialSummary` (Task 2); `GET /api/settings/aws-credentials?companyId=` (Task 3); `GET /api/aws/iam-users?companyId=&credentialId=` (Task 5); `ResourceGrid`, `ResourceLegend` (unchanged).
- Produces: unchanged external prop signature `AwsIamUsersTab({ companyId: string })`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AwsIamUsersTab from './AwsIamUsersTab';

const connectionsResponse = {
  connections: [{ id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' }],
};

function makeResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connected: true,
    fetchedAt: '2026-08-24T12:00:00.000Z',
    users: { data: [], error: null },
    ...overrides,
  };
}

describe('AwsIamUsersTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('shows a not-connected message when there are no saved AWS connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('renders a row for each IAM user', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [
                {
                  userName: 'jdoe',
                  userId: 'AIDAEXAMPLE',
                  arn: 'arn:aws:iam::123456789012:user/jdoe',
                  path: '/',
                  createDate: '2026-01-01T00:00:00.000Z',
                  passwordLastUsed: '2026-08-01T00:00:00.000Z',
                },
              ],
              error: null,
            },
          }),
      });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText('jdoe')).toBeInTheDocument();
    expect(screen.getByText('AIDAEXAMPLE')).toBeInTheDocument();
  });

  it('shows the age color-code legend', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByText(/new in the last 24 hours/i)).toBeInTheDocument();
  });

  it('links the verify icon to a pre-filled mailto for that IAM user', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeResponse({
            users: {
              data: [
                {
                  userName: 'jdoe',
                  userId: 'AIDAEXAMPLE',
                  arn: 'arn:aws:iam::123456789012:user/jdoe',
                  path: '/',
                  createDate: '2026-01-01T00:00:00.000Z',
                  passwordLastUsed: null,
                },
              ],
              error: null,
            },
          }),
      });

    render(<AwsIamUsersTab companyId="company-1" />);

    await screen.findByText('jdoe');
    const verifyLink = screen.getByRole('link', { name: /email to verify this iam user, jdoe/i });
    const href = decodeURIComponent(verifyLink.getAttribute('href') ?? '');
    expect(href).toContain('mailto:?subject=Verify AWS resource: IAM user jdoe');
    expect(href).toContain('Please verify this IAM user "jdoe" is valid and let me know what it is being used for.');
  });

  it('shows an error without hiding the rest of the page', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeResponse({ users: { data: [], error: 'AccessDenied: not authorized to perform iam:ListUsers' } }),
      });

    render(<AwsIamUsersTab companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/accessdenied/i);
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => makeResponse() });

    const user = userEvent.setup();
    render(<AwsIamUsersTab companyId="company-1" />);

    await screen.findByText(/last refreshed/i);
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
  });

  it("switches accounts via the picker and refetches that account's IAM users", async () => {
    const twoConnections = {
      connections: [
        { id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1' },
        { id: 'conn-2', label: 'Client sandbox', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2' },
      ],
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => twoConnections })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeResponse({ users: { data: [{ userName: 'prod-user', userId: 'A1', arn: 'a', path: '/', createDate: null, passwordLastUsed: null }], error: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeResponse({ users: { data: [{ userName: 'sandbox-user', userId: 'A2', arn: 'a', path: '/', createDate: null, passwordLastUsed: null }], error: null } }),
      });

    const user = userEvent.setup();
    render(<AwsIamUsersTab companyId="company-1" />);

    await screen.findByText('prod-user');
    await user.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/aws/iam-users?companyId=company-1&credentialId=conn-2')
    );
    expect(await screen.findByText('sandbox-user')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- AwsIamUsersTab`
Expected: FAIL — same reason as Task 9's AwsResourcesTab tests.

- [ ] **Step 3: Add the account-picker CSS rule to `components/reports/AwsIamUsersTab.module.css`**

Add:

```css
.accountPicker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.accountPicker select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font: inherit;
}
```

- [ ] **Step 4: Replace `components/reports/AwsIamUsersTab.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResourceGrid, ResourceLegend } from './ResourceGrid';
import type { AwsCredentialSummary, AwsIamUsersResponse, IamUserRow } from '@/lib/types';
import styles from './AwsIamUsersTab.module.css';

interface AwsIamUsersTabProps {
  companyId: string;
}

export default function AwsIamUsersTab({ companyId }: AwsIamUsersTabProps) {
  const [connections, setConnections] = useState<AwsCredentialSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<AwsIamUsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (credentialId: string) => {
      const res = await fetch(`/api/aws/iam-users?companyId=${companyId}&credentialId=${credentialId}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? 'Could not load IAM users.');
      }
      return body as AwsIamUsersResponse;
    },
    [companyId]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/aws-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as AwsCredentialSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadUsers(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load IAM users.');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadUsers]);

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(id);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load IAM users.');
    }
    setRefreshing(false);
  }

  async function handleRefresh() {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await loadUsers(selectedId);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load IAM users.');
    }
    setRefreshing(false);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return <p>AWS isn&apos;t connected yet. Add your AWS access key in the Settings tab to see IAM users.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor="iam-account-picker">Account</label>
          <select
            id="iam-account-picker"
            value={selectedId ?? ''}
            onChange={(e) => handleSelectConnection(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>
          Last refreshed {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ResourceLegend />

      <ResourceGrid<IamUserRow>
        title="IAM Users"
        emptyLabel="No IAM users found."
        result={response.users}
        getCreatedAt={(r) => r.createDate}
        getName={(r) => r.userName}
        resourceType="IAM user"
        columns={[
          { header: 'User name', render: (r) => r.userName },
          { header: 'User ID', render: (r) => r.userId },
          { header: 'Created', render: (r) => r.createDate ?? '—' },
          { header: 'Password last used', render: (r) => r.passwordLastUsed ?? '—' },
        ]}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- AwsIamUsersTab`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add components/reports/AwsIamUsersTab.tsx components/reports/AwsIamUsersTab.module.css components/reports/AwsIamUsersTab.test.tsx
git commit -m "Add a multi-account picker to AwsIamUsersTab"
```

---

### Task 11: Full pipeline, live verification, and cleanup

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything built in Tasks 1-10.
- Produces: nothing new — this task's job is proving the whole feature works end-to-end and leaving no test debris behind.

- [ ] **Step 1: Run the full automated pipeline**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all pass (the only known pre-existing warning is the unrelated `LineItemsTab.tsx` React Compiler notice — do not try to fix that here).

- [ ] **Step 2: Live browser verification**

Using this session's established pattern (disposable Supabase staff test account via the Admin API, real AWS test key provided earlier in this project):

1. Start the dev server (`npm run dev -- -p 3105`, checking the port isn't already in use first).
2. Create a disposable staff test account, sign in, pick an existing test company (e.g. "Golino Tech").
3. Open Settings → confirm the AWS/Azure/GCP/Snowflake sub-tab strip renders, defaulting to AWS.
4. Add **two** AWS connections with different labels (e.g. "Production", "Client sandbox") using the real AWS test key for both (same key is fine — this is testing the multi-row UI, not two different real accounts). Confirm both appear in the list with their masked access key and region.
5. Switch to Azure, add one connection with any placeholder Tenant ID/Client ID/Client Secret/Subscription ID values (no real Azure account needed — Foundation only verifies save/list/delete mechanics for Azure/GCP/Snowflake, per the spec's stated limitation). Confirm it lists and can be disconnected. Repeat briefly for GCP (with a small valid JSON string like `{"type":"service_account"}` for the JSON field) and Snowflake.
6. Go to the AWS tab → Resources sub-tab. Confirm the Account picker shows both AWS connections, defaults to the first, and real AWS resource data loads.
7. Switch the picker to the second AWS connection and confirm the grids refetch (network tab shows a new `/api/aws/resources?...credentialId=...` request) and the "last refreshed" timestamp updates.
8. Repeat step 6-7 briefly on the IAM Users sub-tab.
9. Delete one of the two AWS connections from Settings; confirm the Resources/IAM Users picker now shows only the remaining one.

- [ ] **Step 3: Clean up test artifacts**

- Disconnect every connection added during verification (all 4 providers) from the test company's Settings tab.
- Delete the disposable Supabase auth account via the Admin API (same pattern as prior sessions: `DELETE {SUPABASE_URL}/auth/v1/admin/users/{id}` with the service-role key).
- Stop the dev server. On Windows, if `TaskStop` doesn't actually free the port (a recurring quirk in this environment), find the real PID via `netstat -ano | grep ':3105'` and `taskkill //F //PID <pid>`.
- Remind the user (again) to rotate/delete the AWS test key, since it was reused for this verification pass.

- [ ] **Step 4: Final commit**

If Steps 1-3 required any fixups, commit them:

```bash
git add -A
git commit -m "Fix up multi-cloud credentials foundation after live verification"
```

(Skip this commit entirely if no fixups were needed — do not create an empty commit.)
