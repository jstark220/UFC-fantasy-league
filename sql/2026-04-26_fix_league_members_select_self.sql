-- ============================================================================
-- Final fix: members must be able to SELECT their own row
-- ============================================================================
-- Diagnosis: the symptom was "new row violates row-level security policy
-- for table league_members" on join. We chased the INSERT WITH CHECK for
-- a long time. The INSERT was actually fine. The error came from the
-- SELECT policy filtering out the RETURNING row.
--
-- Why: join-league.js does `.insert(...).select('id').single()`. PostgREST
-- translates this into INSERT ... RETURNING id, then filters the returned
-- rows through the SELECT RLS policy. The SELECT policy was:
--     using (is_league_member(league_id))
-- That function asks "does a row exist in league_members where league_id =
-- X and user_id = auth.uid()?" When called immediately after insert to
-- decide if the user can see their own newly-inserted membership row,
-- it returned false (chicken-and-egg) and PostgREST raised the same
-- generic RLS error message it raises for WITH CHECK failures, masking
-- the real cause.
--
-- Fix: a member can always see their own row. Add `user_id = auth.uid()`
-- as a short-circuit in the SELECT policy. This is also semantically
-- correct: you should be able to see your own membership row regardless
-- of any other condition.
-- ============================================================================

-- Step 1: remove the hardcoded diagnostic policy and restore the proper
-- self-insert policy. The hardcoded policy only let Jacob insert; we
-- need the real one back.
drop policy if exists "league_members_hardcoded_uid_test" on public.league_members;

drop policy if exists "Authenticated users can join a league as themselves"
  on public.league_members;

create policy "Authenticated users can join a league as themselves"
  on public.league_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.leagues where id = league_members.league_id
    )
  );

-- Step 2: replace the SELECT policy so users can always see their own
-- row. The OR makes the chicken-and-egg case work: even before
-- is_league_member can confirm membership, the user can see the row
-- they just inserted (because user_id = auth.uid()).
drop policy if exists "Members can view all members in their leagues"
  on public.league_members;

create policy "Members can view all members in their leagues"
  on public.league_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or is_league_member(league_id)
  );

-- Step 3: delete the test row inserted from the browser console while
-- diagnosing. (team_name = 'console_test', waiver_priority = 99 in
-- league cac9d56e-230f-431f-a622-e6a0b6055895.)
delete from public.league_members
where team_name = 'console_test'
  and user_id   = 'a7764549-b4a1-4ed0-b7be-e7297579a553'
  and league_id = 'cac9d56e-230f-431f-a622-e6a0b6055895';
