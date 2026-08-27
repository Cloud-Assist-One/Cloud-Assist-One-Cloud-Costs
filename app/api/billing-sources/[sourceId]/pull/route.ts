import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { createS3ObjectStore } from '@/lib/objectStoreS3';
import { createAzureBlobObjectStore } from '@/lib/objectStoreAzureBlob';
import type { AzureCredentials } from '@/lib/azureCostQuery';
import { discoverRuns } from '@/lib/exportDiscovery';
import { gunzipIfNeeded } from '@/lib/gunzipIfNeeded';
import { deriveBillingMonth } from '@/lib/deriveBillingMonth';
import { ingestCostFile } from '@/lib/ingestCostFile';
import { periodForMonth } from '@/lib/periodForMonth';
import { parseCostFile } from '@/lib/parseCostFile';
import type { ObjectStore } from '@/lib/objectStore';
import type {
  BillingSourcePullRun,
  BillingSourcePullResult,
  CloudProvider,
  ExportRun,
  RemoteObject,
} from '@/lib/types';

// A pull downloads and parses a year of exports; the default 15s would cut it
// off mid-import. Matches the Azure Cost Details route.
export const maxDuration = 300;

// Caps. Each one is reported when it bites — a run silently dropped would
// make the report claim a completeness it does not have.
const MAX_RUNS = 12;
const MAX_PARTS_PER_RUN = 200;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

/** Names the role rather than echoing the SDK, which is the usual cause of a first pull failing. */
function permissionHint(provider: CloudProvider, err: unknown): string {
  const message = errorMessage(err);
  const status = (err as { statusCode?: number; $metadata?: { httpStatusCode?: number } });
  const denied = status?.statusCode === 403 || status?.$metadata?.httpStatusCode === 403;
  if (!denied) return message;

  return provider === 'aws'
    ? `${message} The credential needs s3:ListBucket on the bucket and s3:GetObject on its contents.`
    : `${message} The app registration needs the Storage Blob Data Reader role on the storage account — a data-plane role the Reader and Cost Management Reader roles do not grant.`;
}

export async function POST(request: NextRequest, context: RouteContext<'/api/billing-sources/[sourceId]/pull'>) {
  const { sourceId } = await context.params;
  const body = await request.json();
  const companyId = body?.companyId;
  const archiveFirst = body?.archiveFirst === true;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  const { data: source } = await adminClient
    .from('billing_file_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!source) {
    return NextResponse.json({ error: 'That bucket is not configured for this company.' }, { status: 404 });
  }

  const { data: credRow } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('id', source.credential_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!credRow) {
    return NextResponse.json({ error: 'The connection this bucket uses no longer exists.' }, { status: 400 });
  }

  const provider = source.cloud_provider as CloudProvider;
  let store: ObjectStore;
  try {
    if (provider === 'aws') {
      const secrets = decryptCredentials<{ accessKeyId: string; secretAccessKey: string }>(credRow.encrypted_payload);
      store = createS3ObjectStore({
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        region: credRow.region ?? 'us-east-1',
        bucket: source.container,
      });
    } else if (provider === 'azure') {
      const secrets = decryptCredentials<AzureCredentials>(credRow.encrypted_payload);
      const [account, container] = String(source.container).split('/');
      store = createAzureBlobObjectStore({
        tenantId: secrets.tenantId,
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
        account,
        container,
      });
    } else {
      return NextResponse.json({ error: `Pulling from a ${provider} bucket is not supported yet.` }, { status: 400 });
    }
  } catch (err) {
    console.error('Failed to build the object store:', err);
    return NextResponse.json({ error: 'Could not read the stored credentials for this bucket.' }, { status: 500 });
  }

  // --- Active period first, so archiving (if any) has something to compare
  // against and this pull's own writes have a fixed target throughout ---
  const { data: activePeriodRow } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .single();

  if (!activePeriodRow) {
    return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
  }

  let activePeriodId = activePeriodRow.id as string;

  // --- Archive first, so the newest month can take the active period ---
  if (archiveFirst) {
    // Scoped to THIS period, not the company at large: a company whose data
    // all sits in already-archived periods must not have its genuinely empty
    // active period archived too — that is exactly the blank Archive-tab
    // entry the spec forbids.
    const { data: activeRows } = await adminClient
      .from('cost_records')
      .select('id')
      .eq('company_id', companyId)
      .eq('period_id', activePeriodId)
      .limit(1);

    if ((activeRows ?? []).length > 0) {
      const archiveResponse = await fetch(new URL('/api/periods/archive', request.nextUrl.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: request.headers.get('cookie') ?? '' },
        body: JSON.stringify({ companyId }),
      });
      const archiveBody = await archiveResponse.json().catch(() => ({}));
      if (!archiveResponse.ok) {
        return NextResponse.json(
          { error: archiveBody.error ?? 'Could not archive the current period before pulling.' },
          { status: 500 }
        );
      }
      // Archiving creates a NEW active period. Re-querying for status =
      // 'active' afterwards would race a concurrent pull or scheduled run and
      // could pick up a stale id — possibly even the period that was just
      // archived. The archive route's own response is authoritative.
      if (typeof archiveBody.newPeriodId !== 'string' || !archiveBody.newPeriodId) {
        return NextResponse.json(
          { error: 'The archive step did not return the new active period.' },
          { status: 500 }
        );
      }
      activePeriodId = archiveBody.newPeriodId;
    }
  }

  // --- Discover ---
  let objects: RemoteObject[];
  let discovered: ExportRun[];
  try {
    objects = await store.list(source.prefix ?? '');
    discovered = await discoverRuns(provider, objects, (key) => store.readManifest(key));
  } catch (err) {
    return NextResponse.json({ error: permissionHint(provider, err) }, { status: 502 });
  }

  const runs: BillingSourcePullRun[] = [];

  // A non-empty listing that discovered nothing is not "nothing to pull" —
  // it is usually a narrow s3:GetObject policy that permits the report parts
  // but not Manifest.json. Without this, the pull reports a bland success
  // having imported nothing, with no clue why.
  if (objects.length > 0 && discovered.length === 0) {
    runs.push({
      key: source.prefix || '(bucket root)',
      month: null,
      status: 'skipped',
      reason: `Found ${objects.length} object(s) but no recognisable cost exports. If this is a Cost and Usage Report bucket, check the credential can read Manifest.json as well as the report parts.`,
    });
  }

  // Newest first, so the 12-run cap keeps the most recent year rather than
  // whichever months the listing happened to return first.
  discovered.sort((a, b) => (b.month ?? '').localeCompare(a.month ?? ''));

  const withinCap = discovered.slice(0, MAX_RUNS);
  for (const dropped of discovered.slice(MAX_RUNS)) {
    runs.push({
      key: dropped.key,
      month: dropped.month,
      status: 'skipped',
      reason: `Older than the ${MAX_RUNS}-month limit. Get earlier months from the provider's console.`,
    });
  }

  // --- Skip runs already ingested, by (source, key, etag) ---
  const { data: alreadyIngested } = await adminClient
    .from('uploaded_files')
    .select('source_object_key, source_object_etag')
    .eq('source_id', sourceId);

  const seen = new Set((alreadyIngested ?? []).map((row) => `${row.source_object_key}::${row.source_object_etag}`));

  const pending = withinCap.filter((run) => {
    if (!seen.has(`${run.key}::${run.etag}`)) return true;
    runs.push({ key: run.key, month: run.month, status: 'skipped', reason: 'Already ingested.' });
    return false;
  });

  // The latest month takes the active period; every earlier month gets an
  // archived one. Computed across everything still pending so the assignment
  // does not depend on processing order.
  const latestMonth = pending.map((run) => run.month).filter(Boolean).sort().pop() ?? null;

  let bytesUsed = 0;

  for (const run of pending) {
    try {
      if (run.parts.length > MAX_PARTS_PER_RUN) {
        runs.push({ key: run.key, month: run.month, status: 'skipped', reason: `More than ${MAX_PARTS_PER_RUN} parts in one run.` });
        continue;
      }
      if (bytesUsed + run.totalBytes > MAX_TOTAL_BYTES) {
        runs.push({ key: run.key, month: run.month, status: 'skipped', reason: 'Would exceed this pull’s size limit. Pull again to continue.' });
        continue;
      }

      const buffers: Buffer[] = [];
      for (const part of run.parts) {
        buffers.push(gunzipIfNeeded(part, await store.get(part)));
      }
      bytesUsed += run.totalBytes;

      // The month decides the period, so it has to be settled before anything
      // is written. A manifest that disagrees with its own contents fails the
      // run rather than importing into the wrong month.
      //
      // Derived from the first part only, not every part: the manifest states
      // the month authoritatively, this derive is only a cross-check, and a
      // CUR part is a slice of the same month, so part one is representative.
      // Parsing all 200 parts twice (once here, again inside ingestCostFile)
      // is the difference between fitting a 40-part month in the 300s budget
      // and not. Fallback (loose-file) runs are single-part anyway.
      const derived = deriveBillingMonth(parseCostFile(buffers[0]).rows);
      if (run.month && derived && run.month !== derived) {
        runs.push({
          key: run.key,
          month: run.month,
          status: 'failed',
          reason: `The export says ${run.month} but its rows are mostly ${derived}.`,
        });
        continue;
      }

      const month = run.month ?? derived;
      if (!month) {
        runs.push({ key: run.key, month: null, status: 'failed', reason: 'Could not tell which month this file is for.' });
        continue;
      }

      const target = await periodForMonth(adminClient, companyId, month, activePeriodId, month === latestMonth);

      const { data: fileRow, error: fileError } = await adminClient
        .from('uploaded_files')
        .insert({
          company_id: companyId,
          cloud_provider: provider,
          filename: run.key.split('/').pop() ?? run.key,
          storage_path: '',
          status: 'processing',
          uploaded_by: guard.userId,
          billing_month: month,
          period_id: target.periodId,
          source_id: sourceId,
          source_object_key: run.key,
          source_object_etag: run.etag,
        })
        .select()
        .single();

      if (fileError || !fileRow) {
        // 23505 is the unique violation on uploaded_files_source_object_idx —
        // another pull got this run first, which is the race the index exists
        // to make safe. Anything else is a real failure and must not be
        // dressed up as a deliberate skip, or the month vanishes from a pull
        // that reports success.
        const raced = (fileError as { code?: string } | null)?.code === '23505';
        runs.push(
          raced
            ? { key: run.key, month, status: 'skipped', reason: 'Already ingested by another pull.' }
            : { key: run.key, month, status: 'failed', reason: errorMessage(fileError) }
        );
        continue;
      }

      const result = await ingestCostFile({
        adminClient,
        companyId,
        cloudProvider: provider,
        periodId: target.periodId,
        uploadedFileId: fileRow.id,
        buffers,
      });

      runs.push(
        result.status === 'processed'
          ? { key: run.key, month, status: 'imported', periodKind: target.kind, rowCount: result.rowCount }
          : { key: run.key, month, status: 'failed', reason: (result.errors ?? []).join(' ') || 'Import failed.' }
      );
    } catch (err) {
      // One bad run never aborts the pull.
      runs.push({ key: run.key, month: run.month, status: 'failed', reason: permissionHint(provider, err) });
    }
  }

  const summary: BillingSourcePullResult = {
    runs,
    imported: runs.filter((run) => run.status === 'imported').length,
    skipped: runs.filter((run) => run.status === 'skipped').length,
    failed: runs.filter((run) => run.status === 'failed').length,
  };

  await adminClient
    .from('billing_file_sources')
    .update({ last_pulled_at: new Date().toISOString(), last_pull_summary: summary })
    .eq('id', sourceId);

  return NextResponse.json(summary);
}
