-- ============================================================================
-- LEAGUE CHAT v2 — direct messages
-- ============================================================================
-- Extends league_messages with an optional recipient_id. Semantics:
--
--   recipient_id IS NULL      → group message (visible to all league members)
--   recipient_id IS NOT NULL  → 1-on-1 DM from member_id (sender) to
--                               recipient_id (target). Only the two parties
--                               can read it.
--
-- Per-thread unread state lives on league_members.dm_last_seen_at as a
-- JSONB map { other_member_id: timestamp }. Tracking it as a single column
-- (rather than a side table) is fine for a max of 8 managers per league —
-- the JSONB is at most 7 keys deep and is fetched in the same query that
-- already loads the user's own member row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- COLUMNS
-- ----------------------------------------------------------------------------
alter table public.league_messages
  add column if not exists recipient_id uuid
    references public.league_members(id) on delete cascade;

-- Group-chat queries: "give me messages where recipient is null."
-- DM queries: "give me messages between A and B." Both benefit from a
-- composite index that includes recipient_id, but we keep the existing
-- (league_id, created_at desc) index for the group-chat read path and
-- add a focused DM-pair index here.
create index if not exists league_messages_dm_pair_idx
  on public.league_messages (league_id, recipient_id, member_id, created_at desc)
  where recipient_id is not null;

alter table public.league_members
  add column if not exists dm_last_seen_at jsonb not null default '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- RLS — UPDATE READ POLICY
-- The v1 policy let any league member read any message in the league.
-- Now we need to restrict DMs to the two parties. Drop and recreate.
-- ----------------------------------------------------------------------------
drop policy if exists "League members can read messages" on public.league_messages;
create policy "League members can read messages"
  on public.league_messages
  for select
  to authenticated
  using (
    -- Anyone in the league can read group messages
    (
      recipient_id is null
      and exists (
        select 1
          from public.league_members lm
         where lm.league_id = league_messages.league_id
           and lm.user_id   = auth.uid()
      )
    )
    or
    -- DMs: only the sender or the recipient can read
    (
      recipient_id is not null
      and exists (
        select 1
          from public.league_members lm
         where lm.user_id = auth.uid()
           and (lm.id = league_messages.member_id
                or lm.id = league_messages.recipient_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- RLS — UPDATE INSERT POLICY
-- The sender (member_id) must always be one of the user's memberships.
-- For DMs: the recipient must also be a member of the same league.
-- ----------------------------------------------------------------------------
drop policy if exists "League members can post messages" on public.league_messages;
create policy "League members can post messages"
  on public.league_messages
  for insert
  to authenticated
  with check (
    -- Sender must be the current user's own membership in this league
    exists (
      select 1
        from public.league_members lm
       where lm.id        = league_messages.member_id
         and lm.league_id = league_messages.league_id
         and lm.user_id   = auth.uid()
    )
    and (
      -- Group message — no further check
      league_messages.recipient_id is null
      or
      -- DM — recipient must also belong to this league
      exists (
        select 1
          from public.league_members lm2
         where lm2.id        = league_messages.recipient_id
           and lm2.league_id = league_messages.league_id
      )
    )
  );

-- No UPDATE / DELETE policies — chat is still append-only in v2.
