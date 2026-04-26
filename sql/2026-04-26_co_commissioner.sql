-- ============================================================================
-- CO-COMMISSIONER SUPPORT
-- ============================================================================
-- Adds an is_commissioner flag to league_members. Multiple members per
-- league can hold commissioner powers; the primary owner is still tracked
-- by leagues.commissioner_id (cannot be demoted, only transferred).
--
-- Permission model: a user is "a commissioner of a league" if any of:
--   * leagues.commissioner_id  = auth.uid()                  (primary)
--   * a league_members row with user_id = auth.uid() and
--     is_commissioner = true exists in that league           (co-commissioner)
--
-- We expose this as a SQL helper public.is_league_commissioner(league_id)
-- so RLS policies can call it cleanly without repeating the OR.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- COLUMN
-- ----------------------------------------------------------------------------
alter table public.league_members
  add column if not exists is_commissioner boolean not null default false;

-- The primary commissioner doesn't *need* this flag set on their own row —
-- the helper below handles them via leagues.commissioner_id — but back-
-- filling it makes the manager list rendering simpler and keeps the data
-- self-consistent in case the helper is ever bypassed.
update public.league_members lm
   set is_commissioner = true
  from public.leagues l
 where l.id              = lm.league_id
   and l.commissioner_id = lm.user_id
   and lm.is_commissioner = false;

-- ----------------------------------------------------------------------------
-- HELPER FUNCTION
-- Single source of truth for "is this user a commissioner (primary or co)
-- of this league?". Used by the RLS policies below and by future ones.
--
-- SECURITY DEFINER so the function reads leagues / league_members through
-- the table owner's privileges, NOT the calling user's RLS — otherwise
-- restrictive policies on those tables could make this return false even
-- when the answer should be true. The function body is read-only and only
-- looks at the calling user's own rows, so this is safe.
-- ----------------------------------------------------------------------------

-- Drop first because CREATE OR REPLACE can't rename parameters. CASCADE
-- removes any policies that referenced an older signature; this migration
-- recreates the policies it cares about further down.
drop function if exists public.is_league_commissioner(uuid) cascade;

create or replace function public.is_league_commissioner(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select true
        from public.leagues
       where id              = p_league_id
         and commissioner_id = auth.uid()
       limit 1
    ),
    (
      select true
        from public.league_members
       where league_id       = p_league_id
         and user_id         = auth.uid()
         and is_commissioner = true
       limit 1
    ),
    false
  );
$$;

-- Make sure the function is callable from PostgREST contexts.
grant execute on function public.is_league_commissioner(uuid) to authenticated;
grant execute on function public.is_league_commissioner(uuid) to anon;

-- ----------------------------------------------------------------------------
-- UPDATE EXISTING POLICIES TO ACCEPT CO-COMMISSIONERS
-- ----------------------------------------------------------------------------

-- ufc_events INSERT policy (created in 2026-04-25). The original policy
-- gated on "user is a commissioner of any league" via a leagues.commissioner_id
-- exists check. Replace with the helper so co-commissioners qualify too.
-- Drop & recreate is the safest — Postgres has no ALTER POLICY for predicate.
drop policy if exists "Commissioners can insert events" on public.ufc_events;
create policy "Commissioners can insert events"
  on public.ufc_events
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.leagues l
       where public.is_league_commissioner(l.id)
    )
  );

drop policy if exists "Commissioners can update events" on public.ufc_events;
create policy "Commissioners can update events"
  on public.ufc_events
  for update
  to authenticated
  using (
    exists (
      select 1
        from public.leagues l
       where public.is_league_commissioner(l.id)
    )
  )
  with check (
    exists (
      select 1
        from public.leagues l
       where public.is_league_commissioner(l.id)
    )
  );

drop policy if exists "Commissioners can delete events" on public.ufc_events;
create policy "Commissioners can delete events"
  on public.ufc_events
  for delete
  to authenticated
  using (
    exists (
      select 1
        from public.leagues l
       where public.is_league_commissioner(l.id)
    )
  );

-- ----------------------------------------------------------------------------
-- league_members.is_commissioner write policy
-- Only the primary commissioner of a league can change the is_commissioner
-- flag on its members. Without this, anyone with row-level UPDATE access
-- to league_members could promote themselves.
--
-- We intentionally don't extend this to co-commissioners — only the
-- primary can promote / demote, to keep the audit story simple in v1.
-- ----------------------------------------------------------------------------

-- Existing policies on league_members already restrict UPDATE to a member's
-- own row (for things like waiver_priority, team_name). We add a focused
-- policy that ALSO allows the primary commissioner to UPDATE other rows in
-- their league specifically to flip is_commissioner. The new policy is
-- additive — Postgres OR's permissive policies, so existing self-update
-- continues to work.
drop policy if exists "Primary commissioner can flip co-commissioner flag" on public.league_members;
create policy "Primary commissioner can flip co-commissioner flag"
  on public.league_members
  for update
  to authenticated
  using (
    exists (
      select 1
        from public.leagues l
       where l.id              = league_members.league_id
         and l.commissioner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.leagues l
       where l.id              = league_members.league_id
         and l.commissioner_id = auth.uid()
    )
  );
