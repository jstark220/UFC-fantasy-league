-- ============================================================================
-- Clean up starter selections when a fighter leaves a roster
--
-- Problem: dropping / trading / waiver-losing a fighter deletes their rosters
-- row, but their starter_selections for UPCOMING events were left behind. A
-- stale selection would (a) show a fighter the team no longer owns still sitting
-- in their lineup, and (b) score points for that team when the fighter fights,
-- even double-counting if the fighter's new owner also starts them.
-- (First seen: The weekend warriors kept Islam Dulatov as a 7/25 starter after
-- dropping him to RearNakedChad.)
--
-- Fix: an AFTER DELETE trigger on rosters removes that (member, fighter) pair's
-- starter_selections for any event whose lineup is still OPEN. Every removal
-- path (lineup drop, waiver processing, trades, commish remove, TERF auto-drop)
-- goes through a rosters DELETE, so one trigger covers them all — no per-path
-- code to keep in sync.
--
-- SAFETY: only future/open events are touched. A locked or completed event's
-- selections are the frozen, scored record and must never be deleted, so the
-- WHERE clause requires is_completed = false AND (no lock set yet OR the lock
-- time is still in the future).
--
-- SECURITY DEFINER so it runs regardless of who triggered the delete (a logged-
-- in user dropping via the app, or the service-role server jobs) without
-- tripping RLS on starter_selections.
-- ============================================================================

create or replace function public.cleanup_starters_on_roster_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.starter_selections ss
  using public.ufc_events ev
  where ss.event_id          = ev.id
    and ss.league_member_id  = old.league_member_id
    and ss.fighter_id        = old.fighter_id
    -- Only events whose lineup is still open — never touch locked/scored ones.
    and ev.is_completed = false
    and (ev.lineup_lock_time is null or ev.lineup_lock_time > now());
  return old;
end;
$$;

-- Drop-and-recreate so re-running this migration is idempotent.
drop trigger if exists trg_cleanup_starters_on_roster_delete on public.rosters;
create trigger trg_cleanup_starters_on_roster_delete
  after delete on public.rosters
  for each row
  execute function public.cleanup_starters_on_roster_delete();

-- Supports the trigger's delete (and the general "this member's pick of this
-- fighter" lookup). No-op if an equivalent index already exists.
create index if not exists idx_starter_selections_member_fighter
  on public.starter_selections (league_member_id, fighter_id);
