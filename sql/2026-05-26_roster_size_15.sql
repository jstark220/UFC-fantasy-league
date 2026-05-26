-- =============================================================================
-- Roster size column default — set the leagues.roster_size column default
-- to 15 so any future INSERT that omits roster_size lands on the v1.2 base
-- construction total (8 men's + 1 Women's Flex + 6 Any-Division Flex).
--
-- Existing leagues are intentionally NOT touched. The commissioner's choice
-- of roster_size is the source of truth; the rest of the app (draft, lineup,
-- waivers, slot caps) computes Any-Division Flex from roster_size at runtime
-- so a commissioner can pick any size and the construction adapts.
--
-- The create-league form's client-side default is also 15 (see
-- public/create-league.html), so most new leagues will set roster_size
-- explicitly and never hit this column default.
-- =============================================================================

alter table leagues alter column roster_size set default 15;
