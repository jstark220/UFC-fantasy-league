-- ============================================================================
-- UFCSTATS IDs + Fight Result Unique Key
-- Enables upsert-safe data ingestion from ufcstats.com scraper scripts.
-- Run this in the Supabase SQL editor before running any ingest scripts.
-- ============================================================================

-- ufc_events: hex ID from ufcstats URLs (e.g. "1fada8a5f77f5555")
-- Used as the upsert conflict key in ingestEvents.js so re-runs don't duplicate.
alter table public.ufc_events
  add column if not exists ufcstats_id text unique;

-- fighters: exact display name as ufcstats spells it (with accents).
-- Written on first successful name match so future ingest runs do an exact
-- lookup instead of the slower normalized-name fuzzy match.
alter table public.fighters
  add column if not exists ufcstats_name text;

-- fight_results: hex ID from the fight detail URL.
-- Used as the upsert conflict key in ingestFightResults.js. Avoids the
-- fighter_a / fighter_b ordering ambiguity that would arise from a
-- (event_id, fighter_a_id, fighter_b_id) unique constraint.
alter table public.fight_results
  add column if not exists ufcstats_fight_id text unique;
