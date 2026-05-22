-- ============================================================================
-- fighter_projections — projected fantasy points for upcoming fights.
-- One row per (fighter, fight). Refreshed by fetchPolymarketOdds.js after each
-- odds upsert, so the projection tracks live market movement.
--
-- Components are stored alongside the total so the UI can show a breakdown
-- ("23.4 pts = 14 base + 7.5 win + 1.6 rank, ×1.2 main event") later if we
-- want it, and so we can sanity-check the algorithm without recomputing.
-- ============================================================================

create table if not exists public.fighter_projections (
  id               uuid          primary key default gen_random_uuid(),
  fighter_id       uuid          not null references public.fighters(id)      on delete cascade,
  fight_id         uuid          not null references public.fight_results(id) on delete cascade,
  projected_points numeric(6,2)  not null,
  -- Component breakdown (all expectations, pre-multiplier where it matters)
  base_pts         numeric(6,2)  not null default 0,
  win_bonus_pts    numeric(6,2)  not null default 0,
  rank_bonus_pts   numeric(6,2)  not null default 0,
  title_bonus_pts  numeric(6,2)  not null default 0,
  multiplier       numeric(4,2)  not null default 1.0,
  p_win_used       numeric(5,4),                    -- P(win) used at compute time
  p_win_source     text,                            -- 'polymarket' | 'rank_heuristic' | 'default'
  fights_sampled   integer,                         -- how many of fighter's past fights fed the base/finish distribution
  computed_at      timestamptz   not null default now(),
  unique (fighter_id, fight_id)
);

create index if not exists fighter_projections_fight_id_idx   on public.fighter_projections (fight_id);
create index if not exists fighter_projections_fighter_id_idx on public.fighter_projections (fighter_id);

-- RLS — same model as fight_odds. Public read, service-role write.
alter table public.fighter_projections enable row level security;

drop policy if exists "fighter_projections readable by all" on public.fighter_projections;
create policy "fighter_projections readable by all"
  on public.fighter_projections
  for select
  using (true);
