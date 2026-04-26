-- ============================================================================
-- FIX: ensure INSERT policy on league_members permits self-join
-- ============================================================================
-- Symptom (from production): joining a league via the invite-code flow
-- failed with 42501 "new row violates row-level security policy for
-- table league_members". The same insert had worked previously.
--
-- Root cause (most likely): the CASCADE drop of public.is_league_commissioner
-- in 2026-04-26_co_commissioner.sql also dropped an older INSERT policy
-- on league_members that referenced that function. CASCADE removes any
-- objects that depend on the dropped function, including policies.
--
-- This migration installs a clean, additive INSERT policy that:
--   * Allows any authenticated user to insert a league_members row whose
--     user_id matches their own auth.uid().
--   * Lets the application enforce per-league rules (max_managers cap,
--     duplicate-member checks) — those checks already happen client-side
--     in join-league.js and don't belong in RLS.
--
-- Multiple permissive INSERT policies on the same table are OR'd, so
-- adding this is harmless even if a similar policy still exists. We use
-- DROP POLICY IF EXISTS first only for our own named policy to keep the
-- migration idempotent.
-- ============================================================================

drop policy if exists "Authenticated users can join a league as themselves"
  on public.league_members;

create policy "Authenticated users can join a league as themselves"
  on public.league_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      -- Sanity check: the league actually exists. Without this, RLS would
      -- happily accept inserts pointing at made-up league_id values; the
      -- FK constraint would catch it later but the error is uglier.
      select 1 from public.leagues where id = league_members.league_id
    )
  );
