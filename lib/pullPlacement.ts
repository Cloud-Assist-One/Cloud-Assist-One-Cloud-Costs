export interface ResolvedRun {
  key: string;
  month: string;
  alreadyIngested: boolean;
}

export interface PlacementPlan {
  latestMonth: string | null;
  willClaimActive: boolean;
  /** Keyed by run key: true when that run should take the active period. */
  isLatestByKey: Map<string, boolean>;
}

/**
 * Which resolved month takes the active billing period, and which run(s)
 * carry it.
 *
 * Pulled out of the pull route (which has no test file, by project
 * convention) so this decision is unit-testable on its own. Two rules make it
 * a closed decision rather than a running one:
 *
 * - `latestMonth` looks at every run, ingested or not — an already-ingested
 *   run for the newest month still has to count, or a re-pull of an older,
 *   rewritten month would look "latest" and wrongly claim the active period.
 * - `willClaimActive` looks only at runs still pending. If the newest month
 *   is already ingested and nothing pending matches it, nothing claims the
 *   active period — a no-change re-pull is a true no-op.
 */
export function planPlacement(runs: readonly ResolvedRun[]): PlacementPlan {
  const latestMonth = runs.length === 0 ? null : runs.map((run) => run.month).sort().pop()!;

  const willClaimActive = runs.some((run) => !run.alreadyIngested && run.month === latestMonth);

  const isLatestByKey = new Map<string, boolean>();
  for (const run of runs) {
    isLatestByKey.set(run.key, willClaimActive && run.month === latestMonth);
  }

  return { latestMonth, willClaimActive, isLatestByKey };
}
