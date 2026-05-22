-- ============================================================================
-- Fight odds table — implied probabilities from prediction-market and
-- sportsbook sources. One row per (fight, source). Polymarket is the only
-- source today but the column layout supports adding DraftKings / SportRadar
-- / etc. without another migration.
-- ============================================================================

create table if not exists public.fight_odds (
  id                 uuid          primary key default gen_random_uuid(),
  fight_id           uuid          not null references public.fight_results(id) on delete cascade,
  source             text          not null,    -- 'polymarket' for now
  fighter_a_prob     numeric(5,4),              -- implied win prob for fight_results.fighter_a (0..1)
  fighter_b_prob     numeric(5,4),              -- implied win prob for fight_results.fighter_b (0..1)
  market_id          text,                       -- source-specific market identifier (conditionId for Polymarket)
  market_url         text,                       -- direct link to the market page (optional)
  liquidity          numeric,                    -- market depth, source-specific units
  volume_24h         numeric,                    -- 24-hour trading volume
  fetched_at         timestamptz   not null default now(),
  -- Polymarket CLOB token IDs, oriented to our fighter_a / fighter_b ordering.
  -- Used to fetch the per-fighter price-history series for the modal chart.
  fighter_a_token_id text,
  fighter_b_token_id text,
  unique (fight_id, source)
);

create index if not exists fight_odds_fight_id_idx on public.fight_odds (fight_id);
create index if not exists fight_odds_source_idx   on public.fight_odds (source);

-- RLS — odds are public reference data (same as fight_results / fighters /
-- ufc_events). Anyone authenticated can read; writes are restricted to the
-- service role used by fetchPolymarketOdds.js (which bypasses RLS).
alter table public.fight_odds enable row level security;

drop policy if exists "fight_odds readable by all" on public.fight_odds;
create policy "fight_odds readable by all"
  on public.fight_odds
  for select
  using (true);
