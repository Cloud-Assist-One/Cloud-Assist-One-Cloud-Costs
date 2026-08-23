import { NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';

export async function DELETE(_request: Request, context: RouteContext<'/api/periods/[periodId]'>) {
  const { periodId } = await context.params;

  const adminClient = createAdminClient();

  const { data: period, error: periodError } = await adminClient
    .from('billing_periods')
    .select('company_id, status')
    .eq('id', periodId)
    .maybeSingle();

  if (periodError) {
    console.error('Failed to look up period before delete:', periodError);
    return NextResponse.json({ error: 'Could not look up that period.' }, { status: 500 });
  }

  if (!period) {
    return NextResponse.json({ error: 'Period not found.' }, { status: 404 });
  }

  const guard = await requireCompanyAccess(period.company_id);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  // The active period is exactly-one-per-company and drives the whole app's
  // "current" view — only an archived, frozen period can be deleted here.
  if (period.status !== 'archived') {
    return NextResponse.json({ error: 'Only archived periods can be deleted.' }, { status: 400 });
  }

  // Storage paths aren't period-scoped folders (they're keyed by company_id),
  // so the exact files to remove must come from this period's own rows,
  // not a prefix sweep — a company-wide sweep would delete other periods' files too.
  const [{ data: files, error: filesError }, { data: notes, error: notesError }] = await Promise.all([
    adminClient.from('uploaded_files').select('storage_path').eq('period_id', periodId),
    adminClient.from('review_notes').select('voice_note_path').eq('period_id', periodId).not('voice_note_path', 'is', null),
  ]);

  if (filesError || notesError) {
    console.error('Failed to look up period files before delete:', filesError ?? notesError);
    return NextResponse.json({ error: 'Could not look up this period\'s stored files.' }, { status: 500 });
  }

  const filePaths = (files ?? []).map((f) => f.storage_path);
  if (filePaths.length > 0) {
    const { error: removeFilesError } = await adminClient.storage.from('billing-files').remove(filePaths);
    if (removeFilesError) {
      console.error('Failed to remove billing-files for period:', removeFilesError);
      return NextResponse.json({ error: 'Could not delete this period\'s stored files.' }, { status: 500 });
    }
  }

  const notePaths = (notes ?? []).map((n) => n.voice_note_path as string);
  if (notePaths.length > 0) {
    const { error: removeNotesError } = await adminClient.storage.from('voice-notes').remove(notePaths);
    if (removeNotesError) {
      console.error('Failed to remove voice notes for period:', removeNotesError);
      return NextResponse.json({ error: 'Could not delete this period\'s voice notes.' }, { status: 500 });
    }
  }

  // uploaded_files cascades cost_records (source_file_id on delete cascade);
  // review_notes/review_todos/time_entries have no children to worry about.
  const { error: deleteFilesError } = await adminClient.from('uploaded_files').delete().eq('period_id', periodId);
  if (deleteFilesError) {
    return NextResponse.json({ error: deleteFilesError.message }, { status: 500 });
  }

  const { error: deleteNotesError } = await adminClient.from('review_notes').delete().eq('period_id', periodId);
  if (deleteNotesError) {
    return NextResponse.json({ error: deleteNotesError.message }, { status: 500 });
  }

  const { error: deleteTodosError } = await adminClient.from('review_todos').delete().eq('period_id', periodId);
  if (deleteTodosError) {
    return NextResponse.json({ error: deleteTodosError.message }, { status: 500 });
  }

  const { error: deleteTimeError } = await adminClient.from('time_entries').delete().eq('period_id', periodId);
  if (deleteTimeError) {
    return NextResponse.json({ error: deleteTimeError.message }, { status: 500 });
  }

  const { error: deletePeriodError } = await adminClient.from('billing_periods').delete().eq('id', periodId);
  if (deletePeriodError) {
    return NextResponse.json({ error: deletePeriodError.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
