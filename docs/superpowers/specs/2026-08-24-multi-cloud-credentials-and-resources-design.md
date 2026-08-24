# Multi-Cloud Credentials & Resource Dashboards — Design Spec

## Overview

The app currently supports one connected cloud account: AWS, one credential set per company, surfaced as a "Resources" grid (EC2/Lambda/ECS/RDS/DynamoDB/APIs/S3) and an "IAM Users" grid under the AWS tab. The user wants the same kind of live-account visibility for Azure, Google Cloud, and Snowflake, and wants companies to be able to connect **multiple accounts per provider** (e.g. a production AWS account and a client's separate AWS account), since a company may need to monitor more than one account per cloud. The credential model also needs to be ready for a **v2 cross-account IAM role** auth method without a rewrite, even though only access-key-style auth ("keys") ships now.

This is a large, multi-part change. It is split into four sub-projects, each getting its own build-and-verify pass:

1. **Foundation** — generalized multi-account credentials schema, a 4-provider Settings UI, and migrating AWS's existing Resources/IAM Users tabs to support picking between multiple saved AWS connections. This spec covers Foundation in full implementation detail.
2. **Azure** Resources + Users dashboards (own spec/plan later)
3. **GCP** Resources + Users dashboards (own spec/plan later)
4. **Snowflake** Resources + Users dashboards (own spec/plan later)

Sub-projects 2–4 are scoped and mapped out below (so Foundation's schema and Settings UI are built to fit them), but their actual resource-fetching routes and grid components are **not** built in this pass.

## Goals (this spec / Foundation)

- Generalize `cloud_provider_credentials` so a company can save **multiple named connections per provider** (e.g. "Production", "Client X sandbox"), instead of today's one-row-per-provider limit.
- Add an `auth_type` column (`'keys'` now; `'role'` reserved for v2) so a future cross-account-role connection type is additive, not a schema rewrite.
- Rework `SettingsTab` into 4 provider sub-tabs (AWS / Azure / GCP / Snowflake), each listing that provider's saved connections and offering an "Add connection" form with **provider-correct fields** (not a forced generic key+secret pair — see mapping below).
- Migrate the existing AWS Resources and IAM Users tabs to work against the new multi-account model: an account-picker dropdown replaces today's single-implicit-connection assumption.
- Document the full per-provider field/resource/user mapping (approved by the user) so sub-projects 2–4 can be built later without re-litigating these decisions.

## Non-goals (this spec)

- **No Azure/GCP/Snowflake resource-fetching or grid UI** — their Settings forms save credentials in this pass; viewing their resources/users is sub-projects 2–4.
- **No v2 cross-account role implementation** — only the `auth_type` column and a payload shape that can accommodate it later. No role-assumption code is written now.
- **No live end-to-end verification against real Azure/GCP/Snowflake accounts** — this session has a real AWS test key to verify against (as in every prior AWS feature), but no equivalent Azure/GCP/Snowflake credentials. Foundation's Azure/GCP/Snowflake forms are verified via mocked component/API tests (save → list → delete, encryption round-trip) only. Real-account verification for those three providers happens whenever sub-projects 2–4 are built, contingent on the user supplying test credentials at that time, the same way they supplied the AWS key.
- No changes to the existing per-row "Verify" mailto icon or age-color-coding logic (`ResourceGrid`) — both are reused as-is by future providers.

## Schema changes

```sql
alter table public.cloud_provider_credentials
  add column label text not null default 'Default',
  add column auth_type text not null default 'keys' check (auth_type in ('keys', 'role'));

drop index public.cloud_provider_credentials_company_provider_idx;

create unique index cloud_provider_credentials_company_provider_label_idx
  on public.cloud_provider_credentials (company_id, provider, label);
```

- Existing AWS rows backfill to `label = 'Default'`, `auth_type = 'keys'` via the column defaults — no data loss, no manual backfill script needed.
- `encrypted_payload` stays one opaque encrypted blob regardless of `auth_type`. For `'keys'` today it holds provider-specific credential JSON (see mapping below). A future `'role'` row would hold `{ roleArn, externalId }` instead — same column, same encryption code (`lib/cloudCredentialsCrypto.ts`), no migration needed when v2 ships.
- `region` remains a nullable, provider-agnostic column (used by AWS today; unused by others, left null).
- RLS/grants are unchanged (service-role-only, no client-facing policies) — this is additive to an already-correct table.

## Per-provider credential fields and resource/user mapping

Approved by the user; drives both Foundation's Settings forms and sub-projects 2–4's later resource-fetch design.

### AWS (already built; unchanged)
- Fields: Access Key ID, Secret Access Key, Region.
- Resources: EC2, Lambda, ECS, RDS, DynamoDB, APIs, S3.
- Users: IAM Users.

### Azure
- Fields: Tenant ID, Client ID, Client Secret, Subscription ID.
- Resources: Virtual Machines (EC2), Azure Functions (Lambda), Container Instances (ECS), Azure SQL Database (RDS), Cosmos DB (DynamoDB), API Management services (APIs), Storage Accounts (S3).
- Users: Azure AD (Entra ID) users, via Microsoft Graph (`User.Read.All`) — a separate consent grant from ARM resource access; sub-project 2 must document this setup step for the user.

### GCP
- Fields: Project ID, a pasted service-account JSON key (no key/secret pair exists for GCP).
- Resources: Compute Engine instances (EC2), Cloud Functions (Lambda), Cloud Run services (ECS), Cloud SQL instances (RDS), Firestore databases (DynamoDB — closest fit, not a perfect analog), API Gateway (APIs), Cloud Storage buckets (S3).
- Users: Service Accounts (not human users — GCP has no project-scoped "list human users" API; that's a separate Google Workspace Admin product).

### Snowflake
- Fields: Account identifier, Username, Password.
- Resources: Warehouses, Databases, Schemas, Roles — Snowflake is a data warehouse, not general cloud infra, so nothing maps to EC2/Lambda/etc; this tab shows Snowflake's own object types instead.
- Users: `SHOW USERS` — a direct, clean match.

## Settings UI

`components/settings/SettingsTab.tsx` gains an inner `Tabs`/`TabsList` strip (AWS / Azure / GCP / Snowflake), each rendering a per-provider sub-component:

- `AwsCredentialsPanel`, `AzureCredentialsPanel`, `GcpCredentialsPanel`, `SnowflakeCredentialsPanel` (new files under `components/settings/`), each:
  - Lists existing connections for that provider: label, masked identifier (e.g. `AKIA********WXYZ` for AWS; last 4 of Subscription ID for Azure; Project ID for GCP; Account identifier for Snowflake), a "Disconnect" button per row.
  - An "Add connection" form with a required **Label** field plus that provider's specific fields (per the mapping above). Submitting re-fetches the list.
  - Loading/error states match the existing `<p>Loading…</p>` / `<p role="alert">` conventions used throughout the app.

## API routes

- `app/api/settings/aws-credentials/route.ts` — reworked from today's singleton GET/POST/DELETE to a list-based shape:
  - `GET ?companyId=` → list of `{ id, label, accessKeyIdMasked, region }` for that company's AWS connections.
  - `POST` → body `{ companyId, label, accessKeyId, secretAccessKey, region }`, inserts a new row (`auth_type: 'keys'`), no more upsert-by-provider.
  - `DELETE ?companyId=&id=` → deletes one connection by id (not by provider).
- `app/api/settings/azure-credentials/route.ts`, `.../gcp-credentials/route.ts`, `.../snowflake-credentials/route.ts` — new, same GET/POST/DELETE shape, each validating its own field set and building its own `encrypted_payload` JSON shape.
- `app/api/aws/resources/route.ts` and `app/api/aws/iam-users/route.ts` — add a required `credentialId` query param (replacing the implicit "the one AWS row for this company" lookup); `GET ?companyId=&credentialId=`.

## AWS Resources / IAM Users: multi-account picker

- `AwsResourcesTab` and `AwsIamUsersTab` both gain: on mount, fetch the list of saved AWS connections (`GET /api/settings/aws-credentials?companyId=`); if none, show today's "not connected" message; if one or more, show a `<select>` picker (defaulting to the first) next to the Refresh button, and re-fetch resources/users whenever the selected connection changes.
- If a company has zero AWS connections, behavior is identical to today (message pointing at Settings).

## Verification plan (Foundation)

- Unit tests: migration applied and checked via `mcp__supabase__list_migrations`/`execute_sql`; new API routes covered the same way existing ones are (manual verification, this codebase's established convention — no API route has Jest coverage); `SettingsTab` and each provider panel get component tests (mocked `fetch`) covering list/add/delete; `AwsResourcesTab`/`AwsIamUsersTab` tests updated for the picker.
- `npm test` / `npx tsc --noEmit` / `npm run lint` / `npm run build` after implementation, per this session's established rhythm.
- Live browser verification (disposable staff test account, real AWS test key): add two labeled AWS connections to a test company, confirm both appear in Settings, confirm the Resources/IAM Users picker switches between them and re-fetches, confirm deleting one leaves the other intact. Azure/GCP/Snowflake panels are verified for save/list/delete mechanics only (no real account to authenticate against yet).
- Clean up exactly as prior features: disconnect test connections, delete the test company/account if newly created, remind the user to rotate the AWS test key again since it's reused.
