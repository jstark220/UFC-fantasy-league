-- ============================================================================
-- 2026-05-29_analytics_events.sql
--
-- Lightweight, append-only product analytics. First (and currently only) use:
-- counting mock-draft starts. Mock drafts are otherwise entirely client-side
-- (in-memory + localStorage, no Supabase writes), so there was no way to tell
-- how many users had tried one. This logs one row each time a user starts a
-- mock draft.
--
-- Extensible: the `event` text column lets us record other product events
-- later without a schema change.
-- ============================================================================

create table if not exists public.analytics_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  league_id  uuid,
  event      text not null,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_event_idx
  on public.analytics_events (event, created_at desc);

alter table public.analytics_events enable row level security;

-- Authenticated users may log only their OWN events (insert only). There is no
-- SELECT / UPDATE / DELETE policy, so regular users can't read anyone's
-- analytics — query it with the service role (Supabase SQL editor / a Node
-- script using the service role key).
drop policy if exists "log own analytics event" on public.analytics_events;
create policy "log own analytics event"
  on public.analytics_events
  for insert
  to authenticated
  with check (user_id = auth.uid());
