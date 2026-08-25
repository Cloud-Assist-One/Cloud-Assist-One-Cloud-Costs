-- The 12-month trend sidebar (TrendSidebar.tsx) has been removed from the
-- UI: it summed cost_records with no dedupe against re-uploads/corrections,
-- so its totals grew incorrectly on repeated loads. This view had no other
-- consumer, so it's dropped along with the feature.

drop view if exists public.monthly_cost_by_provider;
