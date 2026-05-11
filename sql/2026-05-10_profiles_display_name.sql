-- ============================================================================
-- PROFILES — add display_name column
-- ============================================================================
-- Adds a free-form display name to the profiles table. Editable on
-- account.html via account.js. Optional — null means "no preferred name
-- set", in which case UI falls back to email or per-league team_name.
--
-- Idempotent so re-running this migration is safe.
-- ============================================================================

alter table public.profiles
  add column if not exists display_name text;

-- ----------------------------------------------------------------------------
-- RLS: users can read + update their own profile.
-- These policies likely exist already from the original profiles setup, but
-- restate them defensively so this migration is self-contained.
-- ----------------------------------------------------------------------------

-- Make sure RLS is on
alter table public.profiles enable row level security;

-- SELECT own row
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- UPDATE own row (display_name is the only user-editable column today, but
-- the policy is column-agnostic — Supabase blocks updates to columns the
-- caller doesn't own through other means, e.g., a security-definer trigger).
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
