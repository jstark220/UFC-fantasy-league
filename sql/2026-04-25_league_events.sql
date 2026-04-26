-- ============================================================================
-- LEAGUE EVENTS — unified activity feed
-- ============================================================================
-- One row per noteworthy thing that happens inside a league: drops, claims,
-- trades, joins, draft picks, score pushes. Powers the recent-activity card
-- on the league page and the full-history activity.html page.
--
-- Schema choice notes:
--   * Decoupled from source tables. If waiver_claims/trades schemas change
--     later, the feed history doesn't break.
--   * `kind` is a free-form text rather than a Postgres enum so we can add
--     event types without migrations. RLS doesn't depend on the value.
--   * `data` JSONB carries the kind-specific payload (fighter names, points,
--     opponent member id, etc.). UI builds the human-readable string from it.
--   * actor_member_id can be null for system events (cron jobs, auto-drops).
-- ============================================================================

create table if not exists public.league_events (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references public.leagues(id) on delete cascade,
  actor_member_id   uuid     references public.league_members(id) on delete set null,
  kind              text not null,
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- Single index that powers every feed query (league-scoped, newest first).
-- Future feed surfaces (dashboard cross-league, per-member filter) all start
-- from this same access pattern.
create index if not exists league_events_league_created_idx
  on public.league_events (league_id, created_at desc);

-- Enable RLS — must be on for any policy to take effect
alter table public.league_events enable row level security;

-- ----------------------------------------------------------------------------
-- READ: any member of the league can read its events
-- ----------------------------------------------------------------------------
create policy "League members can read their league's activity"
  on public.league_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.league_members lm
      where lm.league_id = league_events.league_id
        and lm.user_id   = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- INSERT: any member of the league can write events for that league.
--   * The actor_member_id, if set, must reference one of the user's own
--     memberships (prevents impersonation: I can't log a row that pretends
--     to be from someone else).
--   * Null actor is allowed so future server-side code (auto-drops, cron)
--     can write system events; in v1 only authenticated users insert.
-- ----------------------------------------------------------------------------
create policy "League members can write events for their league"
  on public.league_events
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.league_members lm
      where lm.league_id = league_events.league_id
        and lm.user_id   = auth.uid()
    )
    and (
      actor_member_id is null
      or actor_member_id in (
        select id from public.league_members where user_id = auth.uid()
      )
    )
  );

-- No UPDATE / DELETE policies in v1 — activity is append-only.
