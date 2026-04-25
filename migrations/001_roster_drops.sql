-- =============================================================================
-- Migration 001 — roster_drops
--
-- Tracks every drop of a fighter from a roster. Powers two things the new
-- waiver system needs:
--
-- 1. Per-fighter rolling waiver: a dropped fighter is on waivers in this league
--    until 3am ET on (drop_date + 2 calendar days). We compute that from the
--    most recent dropped_at row for (league_id, fighter_id).
--
-- 2. Wednesday auto-drop rule: we only auto-drop a manager who has made fewer
--    than 3 manual drops since the most recent Thursday 3am ET cap expansion.
--    We count rows here with source='manual' since that timestamp.
--
-- Adds are NOT stored here — `rosters.acquired_at` already tracks them.
-- =============================================================================

create table if not exists roster_drops (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references leagues(id) on delete cascade,
  league_member_id  uuid not null references league_members(id) on delete cascade,
  fighter_id        uuid not null references fighters(id) on delete cascade,
  source            text not null check (source in ('manual','claim','auto')),
  dropped_at        timestamptz not null default now()
);

-- Most-recent-drop-per-fighter lookups (rolling waiver check)
create index if not exists roster_drops_league_fighter_time_idx
  on roster_drops (league_id, fighter_id, dropped_at desc);

-- Counting drops per manager since a timestamp (auto-drop rule)
create index if not exists roster_drops_member_time_idx
  on roster_drops (league_member_id, dropped_at desc);

-- =============================================================================
-- RLS
-- League members can read every drop in their league. Server-side processes
-- (waiver processing, auto-drop) use the service role and bypass RLS.
-- Inserts via the browser client come from authenticated managers dropping
-- their own fighter.
-- =============================================================================

alter table roster_drops enable row level security;

-- Read: any authenticated user who is a member of the league can see drops
drop policy if exists "members can read their league drops" on roster_drops;
create policy "members can read their league drops"
  on roster_drops for select
  to authenticated
  using (
    exists (
      select 1 from league_members lm
      where lm.league_id = roster_drops.league_id
        and lm.user_id   = auth.uid()
    )
  );

-- Insert: a manager can record a drop only for their own roster
drop policy if exists "members can insert drops for themselves" on roster_drops;
create policy "members can insert drops for themselves"
  on roster_drops for insert
  to authenticated
  with check (
    exists (
      select 1 from league_members lm
      where lm.id      = roster_drops.league_member_id
        and lm.user_id = auth.uid()
    )
  );
