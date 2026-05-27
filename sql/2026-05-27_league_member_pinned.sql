-- ============================================================================
-- 2026-05-27_league_member_pinned.sql
--
-- Adds a per-member `pinned` flag so a user can pin a league to the top
-- of their dashboard list. The flag lives on league_members (not on a
-- user-level table) so each (user, league) pair has its own pin state.
--
-- RLS: no new policy needed. Existing policies on league_members already
-- restrict UPDATE to a member's own row (see 2026-04-26_co_commissioner.sql
-- where the comment explicitly notes self-update is permitted for fields
-- like waiver_priority and team_name). Pinned writes piggyback on that.
-- ============================================================================

alter table public.league_members
  add column if not exists pinned boolean not null default false;

-- Partial index: tiny in practice (most rows are unpinned). Helps any
-- future query that needs "my pinned leagues" without a full scan.
create index if not exists league_members_user_pinned_idx
  on public.league_members (user_id)
  where pinned;
