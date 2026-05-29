-- ============================================================================
-- 2026-05-29_prelim_start_time.sql
--
-- Adds a factual "prelim_start_time" to ufc_events: the scheduled start of the
-- FIRST bout on the card (the early prelims), stored in UTC. Populated
-- automatically by enrichEventTimes.js from ESPN's MMA API, which - unlike
-- ufcstats.com (our event-list source) - publishes actual broadcast times.
-- ESPN gives a start time per fight; the earliest one is the prelim start.
--
-- Why a dedicated column instead of just writing lineup_lock_time:
--   prelim_start_time is a FACT about the real event. lineup_lock_time is a
--   league CHOICE that a commissioner can override (see league_event_overrides).
--   Keeping them separate lets us refresh the factual time as ESPN firms it up
--   on fight week WITHOUT stomping a lock a commish already set by hand.
--   enrichEventTimes.js defaults lineup_lock_time to prelim_start_time only
--   when the lock is still unset (or when explicitly run with --relock).
--
-- timestamptz (not a local time) because the start is an absolute instant. A
-- Macau card that begins Saturday morning US time is just one UTC moment; the
-- frontend already renders timestamps in each viewer's local zone, so there is
-- no per-event timezone math to do.
-- ============================================================================

alter table public.ufc_events
  add column if not exists prelim_start_time timestamptz;

comment on column public.ufc_events.prelim_start_time is
  'Scheduled start of the first bout (early prelims), in UTC. Auto-populated by enrichEventTimes.js from ESPN (earliest competition time on the card). lineup_lock_time defaults to this when unset.';
