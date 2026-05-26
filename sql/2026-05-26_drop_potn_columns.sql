-- =============================================================================
-- Drop Performance of the Night from the scoring system
--
-- Why: ufcstats doesn't expose PotN per-fighter (only a card-level icon
-- indicating the bonus existed), and we don't want any manual commissioner
-- input on game-day. The bonus has been removed from scoring.js, the score
-- breakdown UI, the league settings form, the league primer, and the
-- landing page. This migration removes the underlying columns so the
-- schema matches reality.
--
-- Safe to run idempotently — every DROP is gated on IF EXISTS.
-- =============================================================================

-- Per-fight PotN flags on fight_results
alter table fight_results drop column if exists fighter_a_potn;
alter table fight_results drop column if exists fighter_b_potn;

-- Per-score breakdown column on the scores table (written by score-event.js
-- when the commissioner saved a scored event). The column exists even on
-- leagues that never used PotN; dropping it is harmless either way.
alter table scores drop column if exists potn_bonus;
