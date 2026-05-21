-- ============================================================================
-- Fight order column
-- Stores the 1-based index of each fight on its event card, scraped from
-- ufcstats event pages. This is what lets the lineup page split a card into
-- Main Card vs Prelims sections — the existing card_position enum only has
-- main_event / co_main / main_card and can't distinguish prelims from main.
--
-- Existing rows stay NULL until the next ingestFightResults.js run repopulates
-- them (the weekly Tuesday pipeline does this automatically).
-- ============================================================================

alter table public.fight_results
  add column if not exists fight_order integer;

-- Helpful for ordered fetches in the lineup fight card display.
create index if not exists fight_results_event_order_idx
  on public.fight_results (event_id, fight_order);
