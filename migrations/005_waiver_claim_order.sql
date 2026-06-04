-- =============================================================================
-- Migration 005 — waiver_claims.claim_order
--
-- Adds a per-manager PREFERENCE order to waiver claims. When a manager has
-- several open claims, this number (0-based) decides which the rolling
-- round-robin processor tries first. The "My Claims" page lets managers
-- reorder their pending claims with up/down arrows, which writes this column.
--
-- Nullable on purpose: existing claims stay NULL and are NOT modified. Both
-- the display and the processor sort by claim_order ascending with NULLs
-- treated as "after" any explicitly-ordered claim, falling back to
-- submitted_at. So nothing changes for claims placed before this migration
-- until the manager actively reorders them.
--
-- submitted_at is deliberately left untouched by reordering — the waiver
-- process-time windows (pre/post/rolling) are derived from it.
-- =============================================================================

ALTER TABLE waiver_claims
  ADD COLUMN IF NOT EXISTS claim_order integer;

-- Optional: makes "show my claims in order" reads cheap. Safe to skip.
CREATE INDEX IF NOT EXISTS idx_waiver_claims_member_order
  ON waiver_claims (league_member_id, claim_order);
