-- ============================================================================
-- Commissioner draft controls: pause/resume, revert last pick, clear board
-- ============================================================================
-- Three escape hatches for the commissioner during a live draft:
--
--   * Pause/resume — flip a timestamp on leagues.draft_paused_at. Picks are
--     blocked client-side while paused; everyone sees the same paused state
--     via the existing leagues realtime subscription.
--
--   * Revert last pick — RPC that deletes the most recent draft_picks row
--     and the matching rosters row in a single transaction. SECURITY DEFINER
--     because the deletes need to bypass RLS (which would otherwise prevent
--     the commish from removing another member's roster row).
--
--   * Clear board — RPC that wipes every draft-acquired roster row + every
--     draft_picks row for the league. Used when a draft has gone off the
--     rails badly enough that a restart is the cleanest fix.
--
-- Both RPCs check that the caller is the commissioner (primary or co-) of
-- the target league. Without that check, SECURITY DEFINER would let any
-- authenticated user wipe any league's draft.
-- ============================================================================

-- 1) Pause column
alter table public.leagues
  add column if not exists draft_paused_at timestamptz;

-- 2) Authorization helper. Returns true when the calling user is the primary
--    commissioner OR a co-commissioner of the given league. Reused by both
--    RPCs below.
create or replace function public.is_commish_of(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.leagues l
    where l.id = p_league_id
      and l.commissioner_id = auth.uid()
  ) or exists (
    select 1 from public.league_members lm
    where lm.league_id = p_league_id
      and lm.user_id   = auth.uid()
      and lm.is_commissioner = true
  );
$$;

-- 3) Revert the most recent pick.
create or replace function public.revert_last_draft_pick(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_pick_id   uuid;
  v_last_roster_id uuid;
begin
  if not public.is_commish_of(p_league_id) then
    raise exception 'Only the commissioner can revert picks';
  end if;

  -- Find the most recent pick (highest draft_pick number).
  select dp.id into v_last_pick_id
  from public.draft_picks dp
  where dp.league_id = p_league_id
  order by dp.draft_pick desc
  limit 1;

  if v_last_pick_id is null then
    return; -- nothing to revert
  end if;

  -- Delete the matching rosters row first (it's the source of truth; the
  -- draft_picks row is a denormalised copy populated by sync_draft_pick_trigger).
  delete from public.rosters r
  using public.draft_picks dp
  where dp.id = v_last_pick_id
    and r.league_id        = dp.league_id
    and r.fighter_id       = dp.fighter_id
    and r.league_member_id = dp.league_member_id
    and r.acquired_method  = 'draft';

  -- Then the draft_picks row itself. (If the sync trigger was a delete-
  -- mirroring trigger we wouldn't need this, but it only mirrors inserts.)
  delete from public.draft_picks where id = v_last_pick_id;

  -- If the draft had completed, un-complete it so the UI shows live state again.
  update public.leagues
  set draft_completed = false
  where id = p_league_id and draft_completed = true;
end;
$$;

grant execute on function public.revert_last_draft_pick(uuid) to authenticated;

-- 4) Clear the entire draft board.
create or replace function public.clear_draft_board(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_commish_of(p_league_id) then
    raise exception 'Only the commissioner can clear the draft board';
  end if;

  -- Wipe every draft-acquired roster row and every draft_picks row.
  -- Other roster rows (waiver claims, trades) stay intact, though if this
  -- is run mid-draft those won't exist anyway.
  delete from public.rosters
  where league_id = p_league_id
    and acquired_method = 'draft';

  delete from public.draft_picks
  where league_id = p_league_id;

  -- Reset draft_completed so the room renders the live UI again.
  update public.leagues
  set draft_completed = false
  where id = p_league_id;
end;
$$;

grant execute on function public.clear_draft_board(uuid) to authenticated;
