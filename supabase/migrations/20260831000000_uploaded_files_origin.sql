-- Where a batch of cost data came from, so the report can say so.
--
-- Three writers create uploaded_files rows and until now only one of them was
-- identifiable after the fact: the bucket pull sets source_id, while the Quick
-- Pull and a hand-uploaded spreadsheet both leave it null. Telling those two
-- apart meant pattern-matching storage_path against the pull artifact naming,
-- which is a convention rather than a contract -- and one that already varies
-- by provider (AWS writes ...-aws-cost-explorer-pull.json, Azure writes
-- ...-azure-cost-details-pull.csv), so the obvious "artifacts are .json" guess
-- would have mislabelled every Azure quick pull.
alter table public.uploaded_files
  add column origin text;

-- Backfill before the constraint, so existing rows do not have to be guessed
-- at again later:
--   * source_id set        -> it came from a bucket, unambiguously
--   * a pull artifact path -> one of the two Quick Pull writers
--   * anything else        -> somebody uploaded a file
update public.uploaded_files
set origin = case
  when source_id is not null then 'detail_pull'
  when storage_path like '%-aws-cost-explorer-pull.json' then 'quick_pull'
  when storage_path like '%-azure-cost-details-pull.csv' then 'quick_pull'
  else 'upload'
end
where origin is null;

alter table public.uploaded_files
  alter column origin set default 'upload',
  alter column origin set not null,
  add constraint uploaded_files_origin_check
    check (origin in ('quick_pull', 'detail_pull', 'upload'));

-- The report reads the newest processed row for a company/provider/period to
-- label the billing month, and now reads origin and created_at from that same
-- row. That lookup already sorts by created_at.
create index if not exists uploaded_files_period_created_idx
  on public.uploaded_files (company_id, cloud_provider, period_id, created_at desc);
