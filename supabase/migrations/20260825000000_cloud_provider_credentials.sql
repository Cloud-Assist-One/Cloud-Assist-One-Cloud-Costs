-- Stores connection credentials for external cloud provider accounts (AWS
-- today; Azure/GCP/Snowflake later reuse the same table). The secret itself
-- is stored as one opaque encrypted blob (see lib/cloudCredentialsCrypto.ts)
-- rather than provider-specific columns, since each provider's credential
-- shape differs (AWS: access key + secret; Azure: tenant/client id/secret;
-- GCP: service-account JSON; Snowflake: account/user/key).

create table public.cloud_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('aws', 'azure', 'gcp', 'snowflake')),
  encrypted_payload text not null,
  region text,
  metadata jsonb not null default '{}',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index cloud_provider_credentials_company_provider_idx
  on public.cloud_provider_credentials (company_id, provider);

alter table public.cloud_provider_credentials enable row level security;

-- No client-facing policies at all — every read/write goes through an API
-- route using the service-role admin client (see requireCompanyAccess +
-- createAdminClient in the new /api/settings/aws-credentials and
-- /api/aws/resources routes), matching how public.archive_billing_period is
-- service_role-only. RLS enabled with zero authenticated-role policies means
-- `authenticated`/`anon` get nothing even if a GRANT were ever added here by
-- mistake in the future.
grant select, insert, update, delete on public.cloud_provider_credentials to service_role;
