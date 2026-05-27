-- ============================================================================
-- 2026-05-27_league_event_overrides.sql
--
-- Per-league overrides for ufc_events.
--
-- Background: ufc_events is a single global reference table (real UFC
-- schedule). Previously, commissioner edits in the league app wrote
-- straight to ufc_events, which leaked changes into every league using
-- that event. This table introduces a league-scoped override layer so
-- commissioners can customize event details (typically date / lock time
-- for TERF testing) without affecting other leagues.
--
-- Read pattern: code that fetches an event for a league context also
-- fetches the matching override row and merges non-null fields on top
-- of the base ufc_events row. See public/js/event-overrides.js for the
-- canonical merge logic.
--
-- All overrideable fields are nullable so a commish can override just
-- one column (e.g., bump the lock time) without having to re-enter the
-- rest.
-- ============================================================================

create table if not exists public.league_event_overrides (
  league_id          uuid not null references public.leagues(id)    on delete cascade,
  event_id           uuid not null references public.ufc_events(id) on delete cascade,
  name               text,
  full_name          text,
  event_date         date,
  lineup_lock_time   timestamptz,
  venue              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (league_id, event_id)
);

create index if not exists league_event_overrides_event_idx
  on public.league_event_overrides (event_id);

-- Keep updated_at fresh on UPDATE for audit / debugging
create or replace function public.touch_league_event_overrides()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_league_event_overrides on public.league_event_overrides;
create trigger trg_touch_league_event_overrides
  before update on public.league_event_overrides
  for each row execute function public.touch_league_event_overrides();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.league_event_overrides enable row level security;

-- READ: any member of the league can read its overrides (so every member
-- sees the same effective event details, not just the commissioner).
drop policy if exists "League members read league event overrides" on public.league_event_overrides;
create policy "League members read league event overrides"
  on public.league_event_overrides
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.league_members lm
       where lm.league_id = league_event_overrides.league_id
         and lm.user_id   = auth.uid()
    )
  );

-- WRITE: only the primary commissioner OR a co-commissioner of the league
-- can create / update / delete overrides. Reuses is_league_commissioner()
-- which already encapsulates that logic (see co_commissioner migration).
drop policy if exists "League commissioners write league event overrides" on public.league_event_overrides;
create policy "League commissioners write league event overrides"
  on public.league_event_overrides
  for all
  to authenticated
  using (
    public.is_league_commissioner(league_event_overrides.league_id)
  )
  with check (
    public.is_league_commissioner(league_event_overrides.league_id)
  );
