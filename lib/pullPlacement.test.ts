import { planPlacement } from './pullPlacement';
import type { ResolvedRun } from './pullPlacement';

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
