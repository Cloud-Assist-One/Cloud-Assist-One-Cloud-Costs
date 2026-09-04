-- Trial walkthrough dismissal ----------------------------------------------
--
-- The walkthrough opens once per browser session while a company is still in
-- its trial. This column is the permanent opt-out behind the "Don't show this
-- again" checkbox on the final step.
--
-- Per PROFILE, not per company, deliberately: two people at the same client
-- each need their own onboarding, and one of them ticking the box must not
-- silently skip the tour for a colleague who has never seen it.
--
-- Null means "never dismissed", which is the state every existing and future
-- profile starts in -- so no backfill is needed and nobody loses a tour they
-- have not been shown yet.
alter table public.profiles
  add column walkthrough_dismissed_at timestamptz;

-- No new RLS policy, deliberately. There is no own-row update policy on
-- profiles -- only profiles_update_staff -- and that absence is load-bearing:
-- `grant update on public.profiles to authenticated` is table-wide, so a
-- policy letting a client update its own row would also let it set its own
-- role to 'admin'. Adding one here to save a round trip would open a
-- privilege-escalation path for the sake of a checkbox.
--
-- The dismiss route therefore writes this column with the service-role client,
-- scoped server-side to the caller's own auth.uid(). That keeps the route the
-- single writer and leaves clients unable to write profiles at all.
