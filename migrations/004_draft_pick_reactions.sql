-- =============================================================================
-- Migration 004 — draft_pick_reactions
--
-- Slack-style emoji reactions on draft picks. Each league member can react
-- to any pick (own or others) with one or more of the supported emojis;
-- counts roll up live across all clients via Supabase Realtime.
--
-- Per-(pick, user, emoji) uniqueness keeps a single user from spamming the
-- same reaction multiple times. The UI treats clicking a reaction the user
-- already gave as "remove" (delete the row).
-- =============================================================================

create table if not exists draft_pick_reactions (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references leagues(id)      on delete cascade,
  draft_pick_id   uuid not null references draft_picks(id)  on delete cascade,
  user_id         uuid not null references auth.users(id)   on delete cascade,
  emoji           text not null,
  created_at      timestamptz not null default now(),

  -- Each user reacts at most once with each emoji on a given pick. A second
  -- click of the same emoji is treated as a toggle (delete the row) in the
  -- client, so this unique key just prevents accidental duplicates from
  -- racing requests.
  unique (draft_pick_id, user_id, emoji)
);

create index if not exists draft_pick_reactions_pick_idx
  on draft_pick_reactions (draft_pick_id);
create index if not exists draft_pick_reactions_league_idx
  on draft_pick_reactions (league_id);

-- =============================================================================
-- RLS
--
-- Reads: any member of the league can see all reactions in their league.
-- Inserts: only the reactor themself can react as themselves, and only on
--          picks that belong to a league they're a member of.
-- Deletes: only the reactor themself can remove their own reaction.
-- Updates: not allowed — reactions are immutable.
-- =============================================================================

alter table draft_pick_reactions enable row level security;

drop policy if exists "members can read their league reactions" on draft_pick_reactions;
create policy "members can read their league reactions"
  on draft_pick_reactions for select
  to authenticated
  using (
    exists (
      select 1 from league_members lm
      where lm.league_id = draft_pick_reactions.league_id
        and lm.user_id   = auth.uid()
    )
  );

drop policy if exists "members can react in their league" on draft_pick_reactions;
create policy "members can react in their league"
  on draft_pick_reactions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from league_members lm
      where lm.league_id = draft_pick_reactions.league_id
        and lm.user_id   = auth.uid()
    )
  );

drop policy if exists "members can remove their own reactions" on draft_pick_reactions;
create policy "members can remove their own reactions"
  on draft_pick_reactions for delete
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- Realtime
--
-- Enable the table in the Supabase realtime publication so connected
-- clients receive INSERT/DELETE events as they happen. This is what powers
-- the live count updates on the draft board.
--
-- REPLICA IDENTITY FULL — needed so DELETE events carry the full row in
-- payload.old, not just the primary key. Without this, other clients
-- can't tell which (pick, user, emoji) was removed and the count won't
-- decrement live on their end.
-- =============================================================================

alter table draft_pick_reactions replica identity full;
alter publication supabase_realtime add table draft_pick_reactions;
