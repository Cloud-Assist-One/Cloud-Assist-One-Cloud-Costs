import { planPlacement, resolveAlreadyIngested, shouldArchiveBeforePull } from './pullPlacement';
import type { IngestedRecord, ResolvedRun } from './pullPlacement';

function run(overrides: Partial<ResolvedRun> & { key: string; month: string }): ResolvedRun {
  return { alreadyIngested: false, ...overrides };
}

describe('planPlacement', () => {
  it('lets the newest of several months claim the active period', () => {
    const plan = planPlacement([
      run({ key: 'aug', month: '2026-08-01' }),
      run({ key: 'jul', month: '2026-07-01' }),
    ]);

    expect(plan.latestMonth).toBe('2026-08-01');
    expect(plan.willClaimActive).toBe(true);
    expect(plan.isLatestByKey.get('aug')).toBe(true);
  });

  it('does not let an older month claim the active period', () => {
    const plan = planPlacement([
      run({ key: 'aug', month: '2026-08-01' }),
      run({ key: 'jul', month: '2026-07-01' }),
    ]);

    expect(plan.isLatestByKey.get('jul')).toBe(false);
  });

  // The regression: the newest month was already ingested and an older month
  // is pending. The old code computed latestMonth from pending alone, so the
  // older month looked "latest" and wrongly claimed the active period.
  it('does not let a pending older month claim the active period when the newest month is already ingested', () => {
    const plan = planPlacement([
      run({ key: 'aug', month: '2026-08-01', alreadyIngested: true }),
      run({ key: 'jul', month: '2026-07-01', alreadyIngested: false }),
    ]);

    expect(plan.latestMonth).toBe('2026-08-01');
    expect(plan.willClaimActive).toBe(false);
    expect(plan.isLatestByKey.get('jul')).toBe(false);
  });

  // The regression: a loose-files bucket has no declared month on any run.
  // Once every run has been resolved to a real month (by the caller, from
  // file contents), placement must still work exactly as it does for
  // declared months — this is what produced a permanently blank active
  // period before the fix.
  it('resolves a latest month and claims the active period when every month came from derived content, not a declared layout', () => {
    const plan = planPlacement([
      run({ key: 'aug', month: '2026-08-01' }),
      run({ key: 'jul', month: '2026-07-01' }),
    ]);

    expect(plan.latestMonth).toBe('2026-08-01');
    expect(plan.willClaimActive).toBe(true);
  });

  it('does not claim the active period when nothing is pending at all', () => {
    const plan = planPlacement([
      run({ key: 'aug', month: '2026-08-01', alreadyIngested: true }),
      run({ key: 'jul', month: '2026-07-01', alreadyIngested: true }),
    ]);

    expect(plan.willClaimActive).toBe(false);
  });

  it('resolves an empty run list to no latest month and no claim', () => {
    const plan = planPlacement([]);

    expect(plan.latestMonth).toBeNull();
    expect(plan.willClaimActive).toBe(false);
    expect(plan.isLatestByKey.size).toBe(0);
  });

  it('marks both runs latest when two share the newest month', () => {
    const plan = planPlacement([
      run({ key: 'aug-a', month: '2026-08-01' }),
      run({ key: 'aug-b', month: '2026-08-01' }),
      run({ key: 'jul', month: '2026-07-01' }),
    ]);

    expect(plan.isLatestByKey.get('aug-a')).toBe(true);
    expect(plan.isLatestByKey.get('aug-b')).toBe(true);
    expect(plan.isLatestByKey.get('jul')).toBe(false);
  });
});

describe('resolveAlreadyIngested', () => {
  const AUGUST = '2026-08-01';
  const ACTIVE = 'period-active';
  const discovered = [{ key: 'aug.csv', etag: 'etag-1', month: AUGUST }];
  const intoActive = () => ACTIVE;

  it('skips a run whose data is already in the period it targets', () => {
    const ingested: IngestedRecord[] = [{ key: 'aug.csv', etag: 'etag-1', periodId: ACTIVE }];

    expect(resolveAlreadyIngested(discovered, ingested, intoActive)[0].alreadyIngested).toBe(true);
  });

  // The bug this function exists for. Archiving moves data out of the active
  // period but leaves its uploaded_files row saying 'processed', so a match on
  // (key, etag) alone reported the run as ingested forever -- and the data
  // could never be pulled back into the period a person had just emptied.
  it('re-imports a run whose data was archived out of the period it targets', () => {
    const ingested: IngestedRecord[] = [{ key: 'aug.csv', etag: 'etag-1', periodId: 'period-archived' }];

    expect(resolveAlreadyIngested(discovered, ingested, intoActive)[0].alreadyIngested).toBe(false);
  });

  it('re-imports when the export was rewritten under a new etag', () => {
    const ingested: IngestedRecord[] = [{ key: 'aug.csv', etag: 'etag-0', periodId: ACTIVE }];

    expect(resolveAlreadyIngested(discovered, ingested, intoActive)[0].alreadyIngested).toBe(false);
  });

  // There is nowhere for the data to already be.
  it('never calls a run ingested when its target period does not exist yet', () => {
    const ingested: IngestedRecord[] = [{ key: 'aug.csv', etag: 'etag-1', periodId: ACTIVE }];

    expect(resolveAlreadyIngested(discovered, ingested, () => null)[0].alreadyIngested).toBe(false);
  });

  it('does not match a row that carries no period at all', () => {
    const ingested: IngestedRecord[] = [{ key: 'aug.csv', etag: 'etag-1', periodId: null }];

    expect(resolveAlreadyIngested(discovered, ingested, intoActive)[0].alreadyIngested).toBe(false);
  });

  it('sends each month to its own period when judging', () => {
    const runs = [
      { key: 'aug.csv', etag: 'e-aug', month: '2026-08-01' },
      { key: 'jul.csv', etag: 'e-jul', month: '2026-07-01' },
    ];
    const ingested: IngestedRecord[] = [
      { key: 'aug.csv', etag: 'e-aug', periodId: ACTIVE },
      { key: 'jul.csv', etag: 'e-jul', periodId: 'archived-july' },
    ];

    const resolved = resolveAlreadyIngested(runs, ingested, (month) =>
      month === '2026-08-01' ? ACTIVE : 'archived-july'
    );

    expect(resolved.map((run) => run.alreadyIngested)).toEqual([true, true]);
  });

  it('carries key and month through unchanged', () => {
    const resolved = resolveAlreadyIngested(discovered, [], intoActive);

    expect(resolved).toEqual([{ key: 'aug.csv', month: AUGUST, alreadyIngested: false }]);
  });
});

describe('shouldArchiveBeforePull', () => {
  const base = {
    archiveFirst: true,
    willClaimActive: true,
    activeMonth: '2026-07-01',
    latestMonth: '2026-08-01',
    activeHasRows: true,
  };

  it('archives when a genuinely newer month is arriving', () => {
    expect(shouldArchiveBeforePull(base)).toEqual({ archive: true, reason: null });
  });

  // The two-cloud bug. Both sources carry the same month, so the second pull
  // was archiving the first one's freshly imported data before importing its
  // own -- and pulling the first again archived the second's straight back.
  it('does not archive when the active period already holds this same month', () => {
    const decision = shouldArchiveBeforePull({ ...base, activeMonth: '2026-08-01' });

    expect(decision.archive).toBe(false);
    expect(decision.reason).toMatch(/already holds 2026-08-01/);
  });

  it('does not archive a no-change re-pull', () => {
    expect(shouldArchiveBeforePull({ ...base, willClaimActive: false }).archive).toBe(false);
  });

  it('does not archive an empty active period', () => {
    expect(shouldArchiveBeforePull({ ...base, activeHasRows: false }).archive).toBe(false);
  });

  it('does not archive when the pull did not ask to', () => {
    expect(shouldArchiveBeforePull({ ...base, archiveFirst: false }).archive).toBe(false);
  });

  // A Quick Pull writes cost_records with no uploaded_files row to read a
  // month from, so the active period's month is genuinely unknown. Unknown
  // cannot be shown to match, and the old behaviour is kept.
  it('archives when the active period has rows but no discoverable month', () => {
    expect(shouldArchiveBeforePull({ ...base, activeMonth: null }).archive).toBe(true);
  });

  // Two sources, one month, walked end to end in the order that broke it.
  it('lets two clouds fill one active period, then rolls over on a new month', () => {
    // AWS first, into an empty active period.
    expect(
      shouldArchiveBeforePull({ ...base, activeHasRows: false, activeMonth: null, latestMonth: '2026-08-01' }).archive
    ).toBe(false);

    // Azure second, with August already in there from AWS: import alongside.
    expect(
      shouldArchiveBeforePull({ ...base, activeMonth: '2026-08-01', latestMonth: '2026-08-01' }).archive
    ).toBe(false);

    // AWS again with nothing new: a true no-op, and still no archive.
    expect(
      shouldArchiveBeforePull({
        ...base,
        willClaimActive: false,
        activeMonth: '2026-08-01',
        latestMonth: '2026-08-01',
      }).archive
    ).toBe(false);

    // September arrives: now August moves aside, both clouds together.
    expect(
      shouldArchiveBeforePull({ ...base, activeMonth: '2026-08-01', latestMonth: '2026-09-01' }).archive
    ).toBe(true);
  });
});
