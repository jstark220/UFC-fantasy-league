-- =============================================================================
-- Migration 003 — draft_picks
--
-- Immutable, append-only record of every draft pick made in a league. The
-- old draft board read draft_round/draft_pick straight off the `rosters`
-- table, but every roster mutation after the draft (trades, drops, auto-
-- drops, waiver claims) deletes the original row, taking the historical
-- pick info with it. This table never gets touched after a draft completes,
-- so the board stays accurate forever.
--
-- A trigger on `rosters` keeps draft_picks in sync automatically: any time
-- a roster row is inserted with both draft_round AND draft_pick populated,
-- a matching draft_picks row is created. JS doesn't need a dual-write.
-- =============================================================================

create table if not exists draft_picks (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references leagues(id) on delete cascade,
  league_member_id  uuid not null references league_members(id),
  fighter_id        uuid not null references fighters(id),
  draft_round       int  not null,
  draft_pick        int  not null,
  picked_at         timestamptz not null default now(),
  -- Pick numbers are unique within a league. If a draft retry re-inserts
  -- a row, ON CONFLICT DO NOTHING in the trigger keeps things idempotent.
  unique (league_id, draft_pick)
);

create index if not exists draft_picks_league_pick_idx
  on draft_picks (league_id, draft_pick);

-- =============================================================================
-- Trigger: mirror draft picks from rosters at insertion time. Only fires
-- for rows where the draft metadata is populated, so post-draft trade /
-- waiver / FA inserts (which leave those columns null) are ignored.
-- =============================================================================

create or replace function sync_draft_pick_from_roster() returns trigger as $$
begin
  if new.draft_pick is not null and new.draft_round is not null then
    insert into draft_picks (
      league_id, league_member_id, fighter_id, draft_round, draft_pick, picked_at
    ) values (
      new.league_id, new.league_member_id, new.fighter_id,
      new.draft_round, new.draft_pick,
      coalesce(new.acquired_at, now())
    )
    on conflict (league_id, draft_pick) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists sync_draft_pick_trigger on rosters;
create trigger sync_draft_pick_trigger
  after insert on rosters
  for each row
  execute function sync_draft_pick_from_roster();

-- =============================================================================
-- Backfill: pull every still-existing draft pick out of the current rosters
-- table. Rows that were already deleted (traded away, dropped) are gone —
-- their original pick number is lost permanently and that cell on the board
-- will stay blank. Future drafts won't have this problem.
-- =============================================================================

insert into draft_picks (
  league_id, league_member_id, fighter_id, draft_round, draft_pick, picked_at
)
select
  r.league_id, r.league_member_id, r.fighter_id,
  r.draft_round, r.draft_pick,
  coalesce(r.acquired_at, now())
from rosters r
where r.draft_pick  is not null
  and r.draft_round is not null
on conflict (league_id, draft_pick) do nothing;

-- =============================================================================
-- RLS
-- League members read their league's draft. Inserts come through the trigger
-- (which is security definer) so the insert policy is restrictive — only
-- the manager themself can directly insert (defensive; the trigger path is
-- the normal one).
-- =============================================================================

alter table draft_picks enable row level security;

drop policy if exists "members can read their league draft" on draft_picks;
create policy "members can read their league draft"
  on draft_picks for select
  to authenticated
  using (
    exists (
      select 1 from league_members lm
      where lm.league_id = draft_picks.league_id
        and lm.user_id   = auth.uid()
    )
  );

drop policy if exists "members can insert their own draft picks" on draft_picks;
create policy "members can insert their own draft picks"
  on draft_picks for insert
  to authenticated
  with check (
    exists (
      select 1 from league_members lm
      where lm.id      = draft_picks.league_member_id
        and lm.user_id = auth.uid()
    )
  );
