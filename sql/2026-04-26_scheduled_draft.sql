-- ============================================================================
-- Scheduled drafts
-- ============================================================================
-- Lets the commissioner pick a date/time at which the draft will auto-start.
-- A pg_cron job runs every minute and flips draft_started for any league
-- whose scheduled time has passed.
--
-- Design notes:
--   * draft_scheduled_at is cleared when the draft actually starts so the
--     UI doesn't have to differentiate "scheduled-then-started" from
--     "scheduled-but-pending".
--   * The cron job runs as the postgres role and uses SECURITY DEFINER on
--     start_scheduled_drafts() to bypass RLS without granting wide perms
--     to authenticated users.
--   * We only auto-start drafts where draft_order is non-null. A scheduled
--     draft with no order would create chaos; the commissioner should
--     always set the order before scheduling, and the UI enforces this
--     too (defense in depth).
-- ============================================================================

-- 1) New column. Nullable: null = no schedule.
alter table public.leagues
  add column if not exists draft_scheduled_at timestamptz;

-- 2) pg_cron extension. No-op if already enabled.
create extension if not exists pg_cron;

-- 3) The flip function. Idempotent: running it multiple times with no
--    eligible rows is a no-op. SECURITY DEFINER bypasses RLS so the cron
--    job (which runs as postgres, not as a logged-in user) can update.
create or replace function public.start_scheduled_drafts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.leagues
  set
    draft_started      = true,
    draft_started_at   = now(),
    draft_scheduled_at = null
  where
    draft_scheduled_at is not null
    and draft_scheduled_at <= now()
    and draft_started      = false
    and draft_order        is not null;
$$;

-- 4) Schedule the function to run every minute. We unschedule any existing
--    job with the same name first so this migration is safely idempotent
--    (re-running it doesn't pile up duplicate jobs).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'start-scheduled-drafts') then
    perform cron.unschedule('start-scheduled-drafts');
  end if;
  perform cron.schedule(
    'start-scheduled-drafts',
    '* * * * *',
    $cmd$select public.start_scheduled_drafts();$cmd$
  );
end;
$$;
