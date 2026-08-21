-- time_entries already has update_staff/delete_staff RLS policies from the prior
-- migration, but authenticated was only granted select/insert — the policies can
-- never be evaluated for a real user without the matching grant.
grant update, delete on public.time_entries to authenticated;

-- Cap the voice-notes bucket now that upload is live, rather than leaving it unbounded.
update storage.buckets
set file_size_limit = 26214400,
    allowed_mime_types = array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']
where id = 'voice-notes';
