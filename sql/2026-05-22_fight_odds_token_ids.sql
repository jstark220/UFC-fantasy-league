-- ============================================================================
-- Add Polymarket CLOB token IDs to fight_odds so the fighter modal can fetch
-- per-fighter price-history series from https://clob.polymarket.com.
--
-- Each token corresponds to one outcome (i.e. one fighter) in the winner
-- market. Stored oriented to our (fighter_a, fighter_b) ordering by
-- fetchPolymarketOdds.js — same convention as fighter_a_prob / fighter_b_prob.
-- ============================================================================

alter table public.fight_odds
  add column if not exists fighter_a_token_id text,
  add column if not exists fighter_b_token_id text;
