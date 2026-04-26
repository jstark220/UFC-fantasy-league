-- ============================================================================
-- DRAFT PICK TIMER
-- ============================================================================
-- Adds per-league configurable pick timer. Default matches PRD §4.3
-- (90 seconds per pick). Settings UI lets the commissioner change it
-- before the draft starts; the value is read by draft.js to drive the
-- countdown clock visible to every drafter.
--
-- Lower bound 30s and upper bound 600s in the CHECK constraint:
--   * 30s minimum keeps the experience tense without being unfair
--     (slow connections / room with bad wifi need at least that)
--   * 600s (10m) maximum is generous — anything longer means the draft
--     stalls indefinitely; better to bump than to remove the cap.
-- ============================================================================

alter table public.leagues
  add column if not exists pick_timer_seconds integer not null default 90
    check (pick_timer_seconds between 30 and 600);

-- Anchors the timer for the FIRST pick in a draft. Subsequent picks use
-- the previous pick's created_at as their anchor. Without this column,
-- pick #1 has no server-side reference point and would have to fall back
-- to "now on each client" which drifts.
--
-- Stamped to now() when the commissioner starts the draft. Nullable so
-- existing leagues that already started the draft don't break — the
-- client falls back to the earliest draft_pick.created_at in that case.
alter table public.leagues
  add column if not exists draft_started_at timestamptz;
