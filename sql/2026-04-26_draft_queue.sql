-- ============================================================================
-- DRAFT QUEUE
-- ============================================================================
-- Each league member maintains a personal, prioritized list of fighters
-- they want to draft. The queue is private — only the owner sees their own
-- queue. When a fighter is drafted (by anyone), they're auto-removed from
-- every queue in that league via a trigger on draft_picks.
--
-- v1 keeps it simple: position is a small integer for ordering, no
-- conflict-resolution semantics across reorders. Caller sets position
-- explicitly when adding/swapping.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLE
-- ----------------------------------------------------------------------------
create table if not exists public.draft_queue (
  league_id         uuid not null references public.leagues(id)        on delete cascade,
  league_member_id  uuid not null references public.league_members(id) on delete cascade,
  fighter_id        uuid not null references public.fighters(id)       on delete cascade,
  position          smallint not null,
  created_at        timestamptz not null default now(),
  primary key (league_member_id, fighter_id)
);

-- Ordered fetch: "give me my queue, top to bottom"
create index if not exists draft_queue_member_position_idx
  on public.draft_queue (league_member_id, position);

-- Lookup by fighter (used by the auto-clean trigger)
create index if not exists draft_queue_fighter_idx
  on public.draft_queue (league_id, fighter_id);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.draft_queue enable row level security;

drop policy if exists "Members can read their own queue"   on public.draft_queue;
drop policy if exists "Members can insert into own queue"  on public.draft_queue;
drop policy if exists "Members can update own queue"       on public.draft_queue;
drop policy if exists "Members can delete from own queue"  on public.draft_queue;

create policy "Members can read their own queue"
  on public.draft_queue
  for select
  to authenticated
  using (
    exists (
      select 1 from public.league_members lm
      where lm.id      = draft_queue.league_member_id
        and lm.user_id = auth.uid()
    )
  );

create policy "Members can insert into own queue"
  on public.draft_queue
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.league_members lm
      where lm.id        = draft_queue.league_member_id
        and lm.league_id = draft_queue.league_id
        and lm.user_id   = auth.uid()
    )
  );

create policy "Members can update own queue"
  on public.draft_queue
  for update
  to authenticated
  using (
    exists (
      select 1 from public.league_members lm
      where lm.id      = draft_queue.league_member_id
        and lm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.league_members lm
      where lm.id      = draft_queue.league_member_id
        and lm.user_id = auth.uid()
    )
  );

create policy "Members can delete from own queue"
  on public.draft_queue
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.league_members lm
      where lm.id      = draft_queue.league_member_id
        and lm.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- AUTO-CLEAN TRIGGER
-- After a draft_picks insert, remove the picked fighter from every queue
-- in that league. SECURITY DEFINER so it runs as table owner — RLS on
-- draft_queue would otherwise block deletes from members other than the
-- one whose row is being removed.
-- ----------------------------------------------------------------------------
create or replace function public.draft_queue_clean_on_pick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.draft_queue
   where league_id  = new.league_id
     and fighter_id = new.fighter_id;
  return new;
end;
$$;

drop trigger if exists draft_queue_clean_on_pick_trigger on public.draft_picks;
create trigger draft_queue_clean_on_pick_trigger
  after insert on public.draft_picks
  for each row
  execute function public.draft_queue_clean_on_pick();

-- ----------------------------------------------------------------------------
-- REALTIME PUBLICATION
-- Add draft_queue to the realtime publication so each user can subscribe
-- to changes on their own queue (e.g., to react when the trigger above
-- removes a fighter that just got drafted by someone else).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = 'draft_queue'
    ) then
      alter publication supabase_realtime add table public.draft_queue;
    end if;
  end if;
end $$;
