-- ============================================================================
-- Fight Night Hub: realtime + version token
-- ============================================================================
-- 1) Add fight_results and scores to the supabase_realtime publication so the
--    hub receives push updates during live events. Without this, postgres_changes
--    channels on these tables silently never fire (same failure mode as the
--    draft board before 2026-04-26_draft_picks_realtime.sql).
--    scores realtime respects RLS, so members only receive their league's rows.
--
-- 2) Add ufc_events.last_scored_at — the hub's version token. scoreEvents.js
--    stamps it at the end of every scoring run (it is the only writer of
--    scores), and the hub's store uses "higher token wins, wholesale" as its
--    only merge rule. Also makes the 60s fallback poll cheap: poll this one
--    column, refetch heavy data only when it moves.
--
-- Idempotent: publication adds are guarded, ADD COLUMN uses IF NOT EXISTS.
-- Run in the Supabase SQL editor.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'fight_results'
    ) then
      alter publication supabase_realtime add table public.fight_results;
    end if;

    if not exists (
      select 1 from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'scores'
    ) then
      alter publication supabase_realtime add table public.scores;
    end if;
  end if;
end $$;

-- Version token: stamped by scoreEvents.js after each scoring run.
alter table public.ufc_events
  add column if not exists last_scored_at timestamptz;

comment on column public.ufc_events.last_scored_at is
  'Fight Night Hub version token: set by scoreEvents.js at the end of every '
  'scoring run. Clients treat a higher value as strictly newer data.';
