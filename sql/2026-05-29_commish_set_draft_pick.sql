-- ============================================================================
-- 2026-05-29_commish_set_draft_pick.sql
--
-- Commissioner "assign a fighter to any board slot" RPC. Lets the commish
-- click any cell on the draft board and set (or replace) the pick there — e.g.
-- to make a pick for an absent manager, or fix a mistake. The draft keeps
-- moving normally because the client's "current pick" is the lowest unfilled
-- slot.
--
-- Like revert_last_draft_pick / clear_draft_board, this is SECURITY DEFINER
-- (the deletes/inserts must bypass RLS to touch another member's rosters row)
-- and gated on is_commish_of(). rosters is the source of truth; the existing
-- sync_draft_pick_trigger mirrors the INSERT into draft_picks (which drives
-- realtime). Deletes must hit both tables (the trigger only mirrors inserts).
--
-- Filling a slot that's already taken first removes the old pick (its fighter
-- returns to the pool), then inserts the new one — all in one transaction.
-- ============================================================================

create or replace function public.commish_set_draft_pick(
  p_league_id        uuid,
  p_draft_pick       int,
  p_draft_round      int,
  p_league_member_id uuid,
  p_fighter_id       uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_commish_of(p_league_id) then
    raise exception 'Only the commissioner can assign picks';
  end if;

  -- The target member must belong to this league (sanity; the client maps the
  -- clicked cell to the slot's manager via the snake order).
  if not exists (
    select 1 from public.league_members
    where id = p_league_member_id and league_id = p_league_id
  ) then
    raise exception 'That manager is not in this league';
  end if;

  -- Remove any pick currently occupying this slot. rosters first (source of
  -- truth), then the mirrored draft_picks row. No-op when the slot is empty.
  delete from public.rosters r
  using public.draft_picks dp
  where dp.league_id = p_league_id
    and dp.draft_pick = p_draft_pick
    and r.league_id        = dp.league_id
    and r.fighter_id       = dp.fighter_id
    and r.league_member_id = dp.league_member_id
    and r.acquired_method  = 'draft';

  delete from public.draft_picks
  where league_id = p_league_id and draft_pick = p_draft_pick;

  -- Insert the new pick. The sync trigger mirrors it into draft_picks, which
  -- fires realtime so every connected client updates. A unique
  -- (league_id, fighter_id) on rosters backstops double-drafting if the picker
  -- filter is ever bypassed.
  insert into public.rosters
    (league_member_id, league_id, fighter_id, acquired_method, draft_round, draft_pick)
  values
    (p_league_member_id, p_league_id, p_fighter_id, 'draft', p_draft_round, p_draft_pick);
end;
$$;

grant execute on function public.commish_set_draft_pick(uuid, int, int, uuid, uuid) to authenticated;
