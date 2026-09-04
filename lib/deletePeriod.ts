import type { createAdminClient } from '@/lib/supabase/admin';

export type DeletePeriodResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Deletes a billing period and everything hanging off it, including its
 * stored files.
 *
 * Shared by the Archive tab's delete button and by archiving, which replaces
 * an existing archive for the same billing month. Keeping one implementation
 * matters because the order is not obvious: Storage objects have to go before
 * the rows naming them, or their paths are lost and the files are orphaned
 * with nothing left pointing at them.
 */
export async function deletePeriodAndContents(
  adminClient: ReturnType<typeof createAdminClient>,
  periodId: string
): Promise<DeletePeriodResult> {
  // Storage paths aren't period-scoped folders (they're keyed by company_id),
  // so the exact files to remove must come from this period's own rows, not a
  // prefix sweep — a company-wide sweep would delete other periods' files too.
  const [
    { data: files, error: filesError },
    { data: notes, error: notesError },
    { data: invoicedEntries, error: invoicedError },
  ] = await Promise.all([
    adminClient.from('uploaded_files').select('storage_path').eq('period_id', periodId),
    adminClient
      .from('review_notes')
      .select('voice_note_path')
      .eq('period_id', periodId)
      .not('voice_note_path', 'is', null),
    // A stamped stripe_invoice_id is the only link between a sent Stripe
    // invoice and the work it billed. Hard-deleting these rows would sever
    // that link permanently, so this has to be checked before anything is
    // destroyed, not skipped or done best-effort.
    adminClient
      .from('time_entries')
      .select('id')
      .eq('period_id', periodId)
      .not('stripe_invoice_id', 'is', null),
  ]);

  if (filesError || notesError || invoicedError) {
    console.error('Failed to look up period files before delete:', filesError ?? notesError ?? invoicedError);
    return { ok: false, status: 500, error: "Could not look up this period's stored files." };
  }

  const invoicedCount = (invoicedEntries ?? []).length;
  if (invoicedCount > 0) {
    return {
      ok: false,
      status: 409,
      error:
        `Cannot delete this period: ${invoicedCount} time ${invoicedCount === 1 ? 'entry has' : 'entries have'} ` +
        `already been invoiced. Deleting them would destroy the only link to the sent Stripe invoice.`,
    };
  }

  const filePaths = (files ?? []).map((f) => f.storage_path);
  if (filePaths.length > 0) {
    const { error: removeFilesError } = await adminClient.storage.from('billing-files').remove(filePaths);
    if (removeFilesError) {
      console.error('Failed to remove billing-files for period:', removeFilesError);
      return { ok: false, status: 500, error: "Could not delete this period's stored files." };
    }
  }

  const notePaths = (notes ?? []).map((n) => n.voice_note_path as string);
  if (notePaths.length > 0) {
    const { error: removeNotesError } = await adminClient.storage.from('voice-notes').remove(notePaths);
    if (removeNotesError) {
      console.error('Failed to remove voice notes for period:', removeNotesError);
      return { ok: false, status: 500, error: "Could not delete this period's voice notes." };
    }
  }

  // uploaded_files cascades cost_records (source_file_id on delete cascade);
  // review_notes/review_todos/time_entries have no children to worry about.
  const tables = ['uploaded_files', 'review_notes', 'review_todos', 'time_entries'] as const;
  for (const table of tables) {
    const { error } = await adminClient.from(table).delete().eq('period_id', periodId);
    if (error) {
      console.error(`Failed to delete ${table} for period:`, error);
      return { ok: false, status: 500, error: error.message };
    }
  }

  const { error: deletePeriodError } = await adminClient.from('billing_periods').delete().eq('id', periodId);
  if (deletePeriodError) {
    console.error('Failed to delete period:', deletePeriodError);
    return { ok: false, status: 500, error: deletePeriodError.message };
  }

  return { ok: true };
}

/**
 * The billing month a period holds, taken from its processed uploads.
 *
 * Every provider in one period must share a billing month (the upload and
 * pull routes both enforce that), so the first one found identifies the
 * period. Returns null for a period that never received any data — those
 * can't be keyed by month and so are never treated as duplicates.
 */
export async function billingMonthForPeriod(
  adminClient: ReturnType<typeof createAdminClient>,
  periodId: string
): Promise<string | null> {
  const { data, error } = await adminClient
    .from('uploaded_files')
    .select('billing_month')
    .eq('period_id', periodId)
    .eq('status', 'processed')
    .not('billing_month', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Failed to read a period\'s billing month:', error);
    return null;
  }

  return (data?.billing_month as string | undefined) ?? null;
}
