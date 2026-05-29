-- ============================================================================
-- 2026-05-29_espn_ids.sql
--
-- ESPN migration support. ufcstats.com now serves a JavaScript bot-challenge
-- to every non-browser client (datacenter AND residential), so the scrapers
-- can't reach it. We're moving event + fight-result ingestion to ESPN's API,
-- which answers plain requests fine and exposes the same per-fight stats
-- (verified: sig strikes / takedowns / knockdowns / control time match ufcstats
-- exactly). These columns are the stable join keys for the new ESPN ingest.
--
--   fighters.espn_athlete_id      ESPN athlete id. Matched once by name, then
--                                 persisted so future runs join exactly and we
--                                 never re-fuzzy-match (avoids duplicate
--                                 fighters - the historical pain point).
--
--   fight_results.espn_competition_id  ESPN competition (bout) id. Becomes the
--                                 upsert key for go-forward fights, replacing
--                                 ufcstats_fight_id. Existing ufcstats-sourced
--                                 rows keep ufcstats_fight_id and are left
--                                 intact - we only use ESPN for new events.
--
-- Both nullable: legacy rows (pre-ESPN) won't have them, new rows will.
-- ============================================================================

alter table public.fighters
  add column if not exists espn_athlete_id text;

alter table public.fight_results
  add column if not exists espn_competition_id text;

-- Fast lookups during ingest (match athletes by id, dedup fights by competition).
create unique index if not exists fighters_espn_athlete_id_key
  on public.fighters (espn_athlete_id)
  where espn_athlete_id is not null;

create unique index if not exists fight_results_espn_competition_id_key
  on public.fight_results (espn_competition_id)
  where espn_competition_id is not null;

comment on column public.fighters.espn_athlete_id is
  'ESPN athlete id. Matched once by name then persisted for exact joins on later ingests (prevents duplicate fighters).';
comment on column public.fight_results.espn_competition_id is
  'ESPN competition (bout) id. Upsert key for ESPN-sourced fights, replacing ufcstats_fight_id going forward.';
