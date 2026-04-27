-- ============================================================================
-- Add draft_picks (and rosters, defensively) to the realtime publication.
-- ============================================================================
-- Symptom: picks land in the database but other clients in the draft room
-- don't see them until they refresh. The picker's own client updates fine
-- because draft.js refetches the table after every pick. Other clients
-- depend on the realtime channel — and that only fires for tables that
-- are members of the supabase_realtime publication.
--
-- We also need REPLICA IDENTITY FULL on draft_picks so DELETE events
-- include the old row's columns (otherwise the commish's "Undo last pick"
-- would broadcast a DELETE with no payload, and handlePickDelete would
-- bail because payload.old.id is undefined).
--
-- Idempotent: pg_publication_tables guards prevent double-add errors,
-- and `alter table ... replica identity full` is a no-op if already set.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'draft_picks'
  ) then
    alter publication supabase_realtime add table public.draft_picks;
  end if;
end $$;

-- Ensure DELETE events carry the row's old values so the Undo flow works.
alter table public.draft_picks replica identity full;
