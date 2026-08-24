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
