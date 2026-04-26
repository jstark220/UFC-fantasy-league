-- ============================================================================
-- LEAGUE CHAT v1 — group chat per league
-- ============================================================================
-- Append-only message stream scoped to one league. Every league member can
-- read their league's messages and post new ones. v1 has no edits, deletes,
-- mentions, or reactions — those come later.
--
-- Realtime: chat.js subscribes to INSERTs on league_messages filtered by
-- league_id, mirroring the pattern draft.js uses for draft_picks.
--
-- Unread state: each member's "last seen" timestamp lives on the existing
-- league_members row (chat_last_seen_at). The unread count is the number
-- of league_messages.created_at rows greater than that timestamp.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLE
-- ----------------------------------------------------------------------------
create table if not exists public.league_messages (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references public.leagues(id)        on delete cascade,
  member_id   uuid not null references public.league_members(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);

-- The only access pattern: "give me the latest N messages for this league."
-- created_at desc means scanning forward from the latest row, perfect for the
-- chat tail render and the unread-count predicate `created_at > last_seen`.
create index if not exists league_messages_league_created_idx
  on public.league_messages (league_id, created_at desc);

-- ----------------------------------------------------------------------------
-- COLUMN: chat_last_seen_at on league_members
-- Stamped to now() when a user opens chat.html (and on each realtime
-- message received while the page is focused). Drives the unread badge.
-- Nullable so the migration backfills cleanly on existing rows.
-- ----------------------------------------------------------------------------
alter table public.league_members
  add column if not exists chat_last_seen_at timestamptz;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.league_messages enable row level security;

-- Read: any member of the league can read its messages.
drop policy if exists "League members can read messages" on public.league_messages;
create policy "League members can read messages"
  on public.league_messages
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.league_members lm
       where lm.league_id = league_messages.league_id
         and lm.user_id   = auth.uid()
    )
  );

-- Insert: any league member can post a message, but the member_id MUST be
-- one of their own membership rows in this league. Prevents impersonation.
drop policy if exists "League members can post messages" on public.league_messages;
create policy "League members can post messages"
  on public.league_messages
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.league_members lm
       where lm.id        = league_messages.member_id
         and lm.league_id = league_messages.league_id
         and lm.user_id   = auth.uid()
    )
  );

-- No UPDATE / DELETE policies in v1 — append-only.
-- Edits will require a new policy in v2 (member can update own row only).

-- ----------------------------------------------------------------------------
-- REALTIME PUBLICATION
-- Supabase exposes realtime via the `supabase_realtime` publication. We
-- need new INSERTs on league_messages to flow through it; without this,
-- chat.js subscribes successfully but never receives events.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Add the table only if it isn't already in the publication, otherwise
    -- this errors. Postgres lacks IF NOT EXISTS for ALTER PUBLICATION ADD.
    if not exists (
      select 1 from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'league_messages'
    ) then
      alter publication supabase_realtime add table public.league_messages;
    end if;
  end if;
end $$;
