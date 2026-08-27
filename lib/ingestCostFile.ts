import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCostFile } from './parseCostFile';
import type { CloudProvider } from './types';

export interface IngestCostFileInput {
  adminClient: SupabaseClient;
  companyId: string;
  cloudProvider: CloudProvider;
  periodId: string;
  uploadedFileId: string;
  /** One per part: a CUR run has many, an upload has one. Parsed and concatenated. */
  buffers: readonly Buffer[];
}

export interface IngestCostFileResult {
  status: 'processed' | 'error';
  rowCount?: number;
  errors?: string[];
  /**
   * True only when parseCostFile threw (corrupt/unparseable bytes) rather than
   * returning an in-band error. Callers that map this to an HTTP status use it
   * to tell "we couldn't even read the file" (500) apart from "we read it and
   * it was bad" (200) — see app/api/upload/route.ts.
   */
  thrown?: boolean;
}

/**
 * Parse cost file bytes into a period's cost_records.
 *
 * Shared by the upload route and the bucket pull so the two cannot drift on
 * the 22-column insert list or on the replace-the-range rule below.
 */
export async function ingestCostFile({
  adminClient,
  companyId,
  cloudProvider,
  periodId,
  uploadedFileId,
  buffers,
}: IngestCostFileInput): Promise<IngestCostFileResult> {
  // Best-effort throughout: if a status update fails the row may be left at
  // 'processing', but the caller is still told what happened.
  async function markError(message: string): Promise<IngestCostFileResult> {
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: message })
      .eq('id', uploadedFileId);
    return { status: 'error', errors: [message] };
  }

  try {
    const rows = [];
    const errors: string[] = [];
    for (const buffer of buffers) {
      const parsed = parseCostFile(buffer);
      rows.push(...parsed.rows);
      errors.push(...parsed.errors);
    }

    if (rows.length === 0) {
      const message = errors.join(' ') || 'No valid rows found.';
      await adminClient
        .from('uploaded_files')
        .update({ status: 'error', error_message: message })
        .eq('id', uploadedFileId);
      return { status: 'error', errors };
    }

    // A re-upload for the same company/provider/date-range should replace the
    // prior data, not add to it — otherwise costs double every time a
    // corrected file is re-uploaded.
    const usageDates = rows.map((row) => row.usage_date);
    const rangeStart = usageDates.reduce((min, date) => (date < min ? date : min));
    const rangeEnd = usageDates.reduce((max, date) => (date > max ? date : max));

    const { error: deleteRecordsError } = await adminClient
      .from('cost_records')
      .delete()
      .eq('company_id', companyId)
      .eq('cloud_provider', cloudProvider)
      .eq('period_id', periodId)
      .gte('usage_date', rangeStart)
      .lte('usage_date', rangeEnd);

    if (deleteRecordsError) return markError(deleteRecordsError.message);

    const { error: insertRecordsError } = await adminClient.from('cost_records').insert(
      rows.map((row) => ({
        company_id: companyId,
        cloud_provider: cloudProvider,
        service_name: row.service_name,
        usage_date: row.usage_date,
        cost: row.cost,
        account_id: row.account_id,
        source_file_id: uploadedFileId,
        // Explicit since Task 1 relaxed the stamping trigger: without this the
        // trigger still fills in the active period, which is right for an
        // upload and wrong for a historical month.
        period_id: periodId,
        resource_id: row.resource_id,
        resource_group: row.resource_group,
        region: row.region,
        availability_zone: row.availability_zone,
        instance_type: row.instance_type,
        database_engine: row.database_engine,
        meter_category: row.meter_category,
        meter_name: row.meter_name,
        usage_type: row.usage_type,
        operation: row.operation,
        subscription_id: row.subscription_id,
        subscription_name: row.subscription_name,
        purchase_type: row.purchase_type,
        reservation_id: row.reservation_id,
        reservation_name: row.reservation_name,
        quantity: row.quantity,
        unit: row.unit,
        unit_price: row.unit_price,
        effective_price: row.effective_price,
        currency: row.currency,
        charge_type: row.charge_type,
        tags: row.tags,
      }))
    );

    if (insertRecordsError) return markError(insertRecordsError.message);

    await adminClient
      .from('uploaded_files')
      .update({ status: 'processed', row_count: rows.length })
      .eq('id', uploadedFileId);

    return { status: 'processed', rowCount: rows.length };
  } catch (err) {
    // parseCostFile (via XLSX.read) throws on corrupted binary input rather
    // than returning an error — catch it here so the uploaded_files row never
    // gets stuck at 'processing'. Marked `thrown` so callers can tell this
    // apart from an in-band parse error (see IngestCostFileResult).
    const message = err instanceof Error ? err.message : 'Could not process the file.';
    await adminClient
      .from('uploaded_files')
      .update({ status: 'error', error_message: message })
      .eq('id', uploadedFileId);
    return { status: 'error', errors: [message], thrown: true };
  }
}
