-- =============================================================================
-- Migration 002 — trades.executed_at
--
-- Splits trade acceptance from trade execution to support a 24-hour review
-- window. After a recipient accepts, the trade sits in "pending review" for
-- 24 hours; rosters don't swap until either the timer expires or the
-- commissioner force-pushes the trade through.
--
-- Lifecycle now:
--   status='proposed'   → recipient hasn't responded
--   status='accepted', executed_at IS NULL    → in 24h review window
--   status='accepted', executed_at IS NOT NULL → swap completed
--   status='rejected'   → recipient rejected
--   status='cancelled'  → proposer cancelled
-- =============================================================================

alter table trades add column if not exists executed_at timestamptz;

-- Backfill: any pre-existing 'accepted' rows are assumed to have already
-- swapped rosters (because that was the v1 behavior). Mark them executed
-- at responded_at so the lazy processor doesn't try to re-run them.
update trades
   set executed_at = responded_at
 where status = 'accepted'
   and executed_at is null;
