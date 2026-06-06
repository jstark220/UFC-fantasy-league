-- ============================================================================
-- 2026-06-06_commish_set_lineup.sql
--
-- Commissioner "edit any team's lineup" RPC. Lets the commish set which of a
-- manager's rostered fighters are STARTERS for a given event — even after the
-- lineup lock (the whole point: fix a mistake or settle a dispute on fight
-- night). starter_selections has no commish write policy, and members can only
-- write their OWN selections, so this is SECURITY DEFINER (bypasses RLS) and
-- gated on is_commish_of(), mirroring commish_set_draft_pick.
--
-- It REPLACES the member's starters for the event: deletes their existing
-- starter_selections rows for that event, then inserts the passed fighters in
-- order (slot_position 1..N). Passing an empty array clears the lineup.
--
-- Validation: caller must be a commissioner of the league, the target member
-- must belong to the league, and every fighter must be on that member's
-- roster. Starter COUNT (2 Fight Night / 3 numbered) is enforced by the UI;
-- this guards only the hard invariants.
--
-- NOTE: editing starters after an event has scored does not retro-update the
-- `scores` table — re-run scoring (Commish Powers → Scores) to reflect it. For
-- a fight that hasn't scored yet, the next scoring pass uses the new starters.
-- ============================================================================

create or replace function public.commish_set_lineup(
  p_league_id        uuid,
  p_league_member_id uuid,
  p_event_id         uuid,
  p_fighter_ids      uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fid uuid;
  v_pos int := 1;
begin
  if not public.is_commish_of(p_league_id) then
    raise exception 'Only the commissioner can edit lineups';
  end if;

  -- Target member must belong to this league.
  if not exists (
    select 1 from public.league_members
    where id = p_league_member_id and league_id = p_league_id
  ) then
    raise exception 'That manager is not in this league';
  end if;

  -- Every starter must be on that member's roster (no benching a fighter they
  -- don't own).
  if exists (
    select 1 from unnest(coalesce(p_fighter_ids, '{}'::uuid[])) as t(fid)
    where not exists (
      select 1 from public.rosters r
      where r.league_member_id = p_league_member_id
        and r.fighter_id       = t.fid
    )
  ) then
    raise exception 'All starters must be on that team''s roster';
  end if;

  -- Replace this member's starters for this event.
  delete from public.starter_selections
  where league_member_id = p_league_member_id
    and event_id         = p_event_id;

  if p_fighter_ids is not null then
    foreach v_fid in array p_fighter_ids loop
      insert into public.starter_selections (league_member_id, event_id, fighter_id, slot_position)
      values (p_league_member_id, p_event_id, v_fid, v_pos);
      v_pos := v_pos + 1;
    end loop;
  end if;
end;
$$;

grant execute on function public.commish_set_lineup(uuid, uuid, uuid, uuid[]) to authenticated;
