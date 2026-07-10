-- ============================================================================
-- Multi-division eligibility
-- Fighters can be rostered at any weight class they realistically compete in,
-- not just their single primary_division. This column holds the full set of
-- divisions a fighter is eligible for. It ALWAYS contains primary_division, so
-- existing single-division behavior is preserved when the array has one entry.
--
-- Populated + refreshed by backfillEligibleDivisions.js. The rule (see that
-- script) is: primary_division, UNION any division fought in the last 1 year
-- (even a single fight — catches fresh move-ups like Vinicius Oliveira moving
-- BW -> FW), UNION any division with >=2 fights in the last 3 years.
--
-- Existing rows stay NULL until the first backfill run populates them. Read
-- paths must fall back to [primary_division] when the column is NULL/empty so
-- nothing breaks in the window between this migration and the backfill.
-- ============================================================================

alter table public.fighters
  add column if not exists eligible_divisions text[];

-- GIN index so "which fighters are eligible at division X" (array containment,
-- eligible_divisions @> ARRAY['welterweight']) stays fast as the pool grows.
create index if not exists idx_fighters_eligible_divisions
  on public.fighters using gin (eligible_divisions);
