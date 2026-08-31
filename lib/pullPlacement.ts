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

/** One processed import already on record, and where its data landed. */
export interface IngestedRecord {
  key: string;
  etag: string;
  periodId: string | null;
}

/** A run as discovery left it, before anything is known about prior imports. */
export interface DiscoveredRun {
  key: string;
  etag: string;
  month: string;
}

/**
 * Which runs are already ingested -- judged against the period each one would
 * land in, not merely against having been imported once at some point.
 *
 * The distinction is the whole fix. "Already ingested" used to mean a
 * processed row existed for this (source, key, etag) anywhere, so an export
 * whose data had since been archived out of the active period could never be
 * pulled back into it: the row still said processed, and the pull skipped it
 * forever, or until the provider happened to rewrite the export under a new
 * etag. That turned an archive -- something a person does deliberately,
 * expecting to re-pull afterwards -- into a one-way door.
 *
 * Judged per target period, a re-pull that would change nothing is still a
 * true no-op, and a re-pull into a period that does NOT hold this data yet
 * does what the person plainly meant by pressing the button.
 *
 * `targetPeriodFor` returns null when the period a month belongs in does not
 * exist yet, which is never "already ingested" -- there is nowhere for the
 * data to already be.
 */
export function resolveAlreadyIngested(
  runs: readonly DiscoveredRun[],
  ingested: readonly IngestedRecord[],
  targetPeriodFor: (month: string) => string | null
): ResolvedRun[] {
  return runs.map((run) => {
    const target = targetPeriodFor(run.month);
    return {
      key: run.key,
      month: run.month,
      alreadyIngested:
        target !== null &&
        ingested.some(
          (record) => record.key === run.key && record.etag === run.etag && record.periodId === target
        ),
    };
  });
}

export interface ArchiveDecision {
  archive: boolean;
  /** Why not, when it declined. Null when it is archiving. */
  reason: string | null;
}

/**
 * Whether to archive the active period before importing into it.
 *
 * Archiving exists to move a *month* aside when a newer one arrives. It was
 * deciding as though it moved a *source* aside, which is what made two clouds
 * unable to coexist: pulling AWS filled the active period, then pulling Azure
 * saw rows in there and archived them -- the AWS data that had just been
 * imported -- before importing its own. Pulling AWS again archived the Azure
 * data straight back. Two sources, one active period, and each pull evicting
 * the other's work.
 *
 * The month is what settles it. When the active period already holds the same
 * month this pull is bringing in, there is nothing to move aside and both
 * sources belong in there together -- ingestCostFile's replace is scoped to
 * one provider and one period, so neither disturbs the other's rows. Only a
 * genuinely newer month archives what came before, which is what a person
 * means by the word.
 */
export function shouldArchiveBeforePull(input: {
  archiveFirst: boolean;
  /** From planPlacement: false when nothing pending would claim the active period. */
  willClaimActive: boolean;
  /** The month sitting in the active period now, or null when it holds none. */
  activeMonth: string | null;
  /** The newest month this pull found. */
  latestMonth: string | null;
  activeHasRows: boolean;
}): ArchiveDecision {
  if (!input.archiveFirst) return { archive: false, reason: 'The pull did not ask to archive.' };

  // A no-change re-pull must not archive: it would move the current period
  // aside and then import nothing, the exact opposite of a no-op.
  if (!input.willClaimActive) {
    return { archive: false, reason: 'Nothing pending would claim the active period.' };
  }

  // Scoped to this period rather than the company at large, so a company whose
  // data all sits in archived periods does not have its genuinely empty active
  // period archived too -- that is the blank Archive-tab entry the spec forbids.
  if (!input.activeHasRows) return { archive: false, reason: 'The active period is empty.' };

  if (input.activeMonth !== null && input.activeMonth === input.latestMonth) {
    return {
      archive: false,
      reason: `The active period already holds ${input.activeMonth}, so this imports alongside it.`,
    };
  }

  // An active period with rows but no month anywhere -- a Quick Pull writes
  // cost_records without an uploaded_files row to read a month from -- cannot
  // be shown to hold this same month, so it is archived as before.
  return { archive: true, reason: null };
}
