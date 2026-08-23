-- Records which calendar month an uploaded file's billing data is for, so
-- the upload route can verify every cloud provider in a period declares the
-- same month before accepting a new upload. Nullable: pre-existing uploads
-- predate this feature and are never checked against it.

alter table public.uploaded_files add column billing_month date;
