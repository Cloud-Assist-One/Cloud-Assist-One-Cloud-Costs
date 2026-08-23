-- Adds Google Cloud ('gcp') and Snowflake ('snowflake') as valid cloud
-- providers alongside the existing 'aws'/'azure', so the two new report
-- tabs can store and query cost data the same way AWS/Azure already do.

alter table public.cost_records drop constraint cost_records_cloud_provider_check;
alter table public.cost_records
  add constraint cost_records_cloud_provider_check
  check (cloud_provider in ('aws', 'azure', 'gcp', 'snowflake'));

alter table public.uploaded_files drop constraint uploaded_files_cloud_provider_check;
alter table public.uploaded_files
  add constraint uploaded_files_cloud_provider_check
  check (cloud_provider in ('aws', 'azure', 'gcp', 'snowflake'));
