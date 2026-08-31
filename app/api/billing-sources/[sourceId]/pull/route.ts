import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { createStoreForSource, errorMessage, permissionHint } from '@/lib/billingSourceStore';
import { discoverRuns } from '@/lib/exportDiscovery';
import { gunzipIfNeeded } from '@/lib/gunzipIfNeeded';
import { deriveBillingMonth } from '@/lib/deriveBillingMonth';
import { ingestCostFile } from '@/lib/ingestCostFile';
import { periodForMonth } from '@/lib/periodForMonth';
import { parseCostFile } from '@/lib/parseCostFile';
import { planPlacement, resolveAlreadyIngested, shouldArchiveBeforePull } from '@/lib/pullPlacement';
import { billingMonthForPeriod } from '@/lib/deletePeriod';
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
// Bounds transfer, not decompressed volume: run.totalBytes sums the remote
// object sizes, which for a CUR run are gzipped. This caps how much a single
// pull downloads, not how much decompressed data it produces — do not treat
// it as a decompressed-size limit.
const MAX_TOTAL_COMPRESSED_BYTES = 500 * 1024 * 1024;

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

  if (!source.enabled) {
    return NextResponse.json({ error: 'This bucket is disabled. Enable it in Settings before pulling.' }, { status: 400 });
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
  const resolved = createStoreForSource({
    provider,
    container: source.container,
    encryptedPayload: credRow.encrypted_payload,
    region: credRow.region ?? null,
  });

  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const store = resolved.store;

  // --- Active period first: everything below needs a fixed id to compare
  // against and to write into ---
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

  if (objects.length === 0) {
    // A silent "imported 0, skipped 0, failed 0" gives no clue whether the
    // bucket/prefix is genuinely empty or something upstream is wrong.
    runs.push({
      key: source.prefix || '(bucket root)',
      month: null,
      status: 'skipped',
      reason: 'This bucket (or prefix) has no objects in it. Nothing to pull.',
    });
  } else if (discovered.length === 0) {
    // A non-empty listing that discovered nothing is not "nothing to pull".
    // Which of the two causes it is matters, because they need opposite
    // fixes, and the earlier single message named only the permissions one --
    // which sent a real CUR 2.0 bucket on a credential hunt for a format
    // problem. Whether a manifest was present is what separates them.
    const manifestCount = objects.filter((object) => /[-/]manifest\.json$/i.test(object.key)).length;
    const reason = manifestCount
      ? `Found ${objects.length} object(s) including ${manifestCount} manifest(s), but none could be read. Either the credential cannot read the manifest, or it is in a format this does not recognise yet.`
      : `Found ${objects.length} object(s) but no manifest and no recognisable cost export. Check the prefix points at the export folder itself.`;

    runs.push({ key: source.prefix || '(bucket root)', month: null, status: 'skipped', reason });
  }

  // --- Resolve every run's month before anything else decides on it ---
  //
  // The 12-run cap, and the choice of which month claims the active period,
  // both have to sort/compare on the REAL month, not the declared one. A
  // loose-files bucket has month: null on every run; leaving that unresolved
  // here is what let the 12-run cap keep the wrong runs and let the active
  // vs. archived decision see an empty list and archive everything.
  //
  // Declared month if the layout stated one; otherwise download that run's
  // first part only, gunzip it, parse it, and derive the month from its
  // rows. The first-part buffer is cached so a run that goes on to be
  // ingested does not pay for a second download of the same object.
  const resolvedDiscovered: { run: ExportRun; month: string }[] = [];
  const firstPartBufferCache = new Map<string, Buffer>();

  for (const run of discovered) {
    if (run.month) {
      resolvedDiscovered.push({ run, month: run.month });
      continue;
    }
    try {
      const firstPart = run.parts[0];
      const buffer = gunzipIfNeeded(firstPart, await store.get(firstPart));
      const derived = deriveBillingMonth(parseCostFile(buffer).rows);
      if (!derived) {
        runs.push({ key: run.key, month: null, status: 'failed', reason: 'Could not tell which month this file is for.' });
        continue;
      }
      firstPartBufferCache.set(run.key, buffer);
      resolvedDiscovered.push({ run, month: derived });
    } catch (err) {
      // One bad run never aborts the pull.
      runs.push({ key: run.key, month: null, status: 'failed', reason: permissionHint(provider, err) });
    }
  }

  // Newest first, so the 12-run cap keeps the most recent year rather than
  // whichever months the listing happened to return first. Sorted on the
  // resolved month — every run has one now — so a month-less run never sorts
  // as an arbitrary tie with every other month-less run.
  resolvedDiscovered.sort((a, b) => b.month.localeCompare(a.month));

  const withinCap = resolvedDiscovered.slice(0, MAX_RUNS);
  for (const dropped of resolvedDiscovered.slice(MAX_RUNS)) {
    runs.push({
      key: dropped.run.key,
      month: dropped.month,
      status: 'skipped',
      reason: `Older than the ${MAX_RUNS}-month limit. Get earlier months from the provider's console.`,
    });
  }

  // --- Which runs are already ingested INTO THE PERIOD THEY BELONG IN ---
  //
  // Scoped to status = 'processed': a run that failed mid-import still has a
  // row here (ingestCostFile only ever flips it to 'error', never removes
  // it), and without this filter that row wrongly looks "already ingested"
  // forever, with no way to retry short of the provider rewriting the export.
  //
  // period_id is selected because a bare (key, etag) match is not enough: data
  // archived out of the active period has to be pullable back into it, and a
  // match that ignored the period made an archive a one-way door. See
  // resolveAlreadyIngested.
  const { data: alreadyIngested } = await adminClient
    .from('uploaded_files')
    .select('source_object_key, source_object_etag, period_id')
    .eq('source_id', sourceId)
    .eq('status', 'processed');

  const ingestedRecords = (alreadyIngested ?? []).map((row) => ({
    key: row.source_object_key as string,
    etag: row.source_object_etag as string,
    periodId: (row.period_id as string | null) ?? null,
  }));

  // Every archived period this company already has, by month, so a run can be
  // matched against the period it would actually land in rather than against
  // the whole of history.
  const { data: archivedPeriods } = await adminClient
    .from('billing_periods')
    .select('id, billing_month')
    .eq('company_id', companyId)
    .eq('status', 'archived')
    .not('billing_month', 'is', null);

  const archivedByMonth = new Map(
    (archivedPeriods ?? []).map((row) => [row.billing_month as string, row.id as string])
  );

  // withinCap is sorted newest month first, so its head is the latest month.
  // planPlacement derives the same value from the same runs below; it is
  // needed here first, because which period a run targets depends on it.
  const latestMonth = withinCap.length > 0 ? withinCap[0].month : null;

  const resolvedRuns = resolveAlreadyIngested(
    withinCap.map(({ run, month }) => ({ key: run.key, etag: run.etag, month })),
    ingestedRecords,
    (month) => (month === latestMonth ? activePeriodId : archivedByMonth.get(month) ?? null)
  );

  // The latest month takes the active period; every earlier month gets an
  // archived one. latestMonth looks at every run within the cap (ingested or
  // not) so an already-ingested newest month is never mistaken for "nothing
  // newer exists". willClaimActive looks only at what is still pending, so a
  // re-pull that changes nothing never archives the current period.
  const plan = planPlacement(resolvedRuns);

  // --- Archive, only when a genuinely newer month is arriving ---
  //
  // Two sources pulling the same month have to land in the same active period
  // together; archiving between them is what made each cloud evict the other's
  // import. See shouldArchiveBeforePull.
  const { data: activeRows } = await adminClient
    .from('cost_records')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_id', activePeriodId)
    .limit(1);

  const activeHasRows = (activeRows ?? []).length > 0;

  // Read from the period's own processed files, the same way the archive route
  // works out which month it is filing away.
  const activeMonth = activeHasRows ? await billingMonthForPeriod(adminClient, activePeriodId) : null;

  const archiveDecision = shouldArchiveBeforePull({
    archiveFirst,
    willClaimActive: plan.willClaimActive,
    activeMonth,
    latestMonth: plan.latestMonth,
    activeHasRows,
  });

  if (archiveDecision.archive) {
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
    // Archiving creates a NEW active period. Re-querying for status = 'active'
    // afterwards would race a concurrent pull or scheduled run and could pick
    // up a stale id — possibly even the period that was just archived. The
    // archive route's own response is authoritative.
    if (typeof archiveBody.newPeriodId !== 'string' || !archiveBody.newPeriodId) {
      return NextResponse.json(
        { error: 'The archive step did not return the new active period.' },
        { status: 500 }
      );
    }
    activePeriodId = archiveBody.newPeriodId;
  }

  let bytesUsed = 0;

  // Judged against the period each run targets, not merely against ever
  // having been imported — see resolveAlreadyIngested.
  const alreadyInTargetPeriod = new Set(
    resolvedRuns.filter((run) => run.alreadyIngested).map((run) => run.key)
  );

  for (const { run, month } of withinCap) {
    if (alreadyInTargetPeriod.has(run.key)) {
      runs.push({ key: run.key, month, status: 'skipped', reason: 'Already ingested into this period.' });
      continue;
    }

    try {
      if (run.parts.length > MAX_PARTS_PER_RUN) {
        runs.push({ key: run.key, month, status: 'skipped', reason: `More than ${MAX_PARTS_PER_RUN} parts in one run.` });
        continue;
      }
      if (bytesUsed + run.totalBytes > MAX_TOTAL_COMPRESSED_BYTES) {
        runs.push({ key: run.key, month, status: 'skipped', reason: 'Would exceed this pull’s size limit. Pull again to continue.' });
        continue;
      }

      const buffers: Buffer[] = [];
      const cachedFirstPart = firstPartBufferCache.get(run.key);
      for (const part of run.parts) {
        if (buffers.length === 0 && cachedFirstPart) {
          buffers.push(cachedFirstPart);
        } else {
          buffers.push(gunzipIfNeeded(part, await store.get(part)));
        }
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

      const finalMonth = run.month ?? derived;
      if (!finalMonth) {
        runs.push({ key: run.key, month: null, status: 'failed', reason: 'Could not tell which month this file is for.' });
        continue;
      }

      const target = await periodForMonth(
        adminClient,
        companyId,
        finalMonth,
        activePeriodId,
        plan.isLatestByKey.get(run.key) ?? false
      );

      const { data: fileRow, error: fileError } = await adminClient
        .from('uploaded_files')
        .insert({
          company_id: companyId,
          cloud_provider: provider,
          filename: run.key.split('/').pop() ?? run.key,
          storage_path: '',
          status: 'processing',
          uploaded_by: guard.userId,
          billing_month: finalMonth,
          origin: 'detail_pull',
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
            ? { key: run.key, month: finalMonth, status: 'skipped', reason: 'Already ingested by another pull.' }
            : { key: run.key, month: finalMonth, status: 'failed', reason: errorMessage(fileError) }
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
          ? { key: run.key, month: finalMonth, status: 'imported', periodKind: target.kind, rowCount: result.rowCount }
          : { key: run.key, month: finalMonth, status: 'failed', reason: (result.errors ?? []).join(' ') || 'Import failed.' }
      );
    } catch (err) {
      // One bad run never aborts the pull.
      runs.push({ key: run.key, month, status: 'failed', reason: permissionHint(provider, err) });
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
